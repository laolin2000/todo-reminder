package com.todoreminder.web

import android.content.Context
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoHTTPD.IHTTPSession
import fi.iki.elonen.NanoHTTPD.Method
import fi.iki.elonen.NanoHTTPD.Response
import fi.iki.elonen.NanoHTTPD.Response.Status
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 手机本地服务器(一体包): 提供与电脑端相同的 API, 数据读写手机本地文件。
 * 单机模式: 只绑 127.0.0.1, 无鉴权(loopback), 无 WebSocket(前端 __NO_WS__ 用轮询)。
 */
class LocalServer(
    port: Int,
    private val ctx: Context,
    private val onDataChanged: Runnable,
) : NanoHTTPD("127.0.0.1", port) {

    private val webRoot: File = ctx.filesDir.web()
    private val aiKit by lazy { AiKit(ctx) }
    private val logFile = File(ctx.filesDir, "local-log.txt")

    @Synchronized
    private fun logLine(s: String) {
        try {
            val lines = if (logFile.exists()) logFile.readText().split("\n").takeLast(300) else emptyList()
            logFile.writeText((lines + listOf(System.currentTimeMillis().toString() + " " + s)).joinToString("\n"))
        } catch (_: Exception) { }
    }

    override fun serve(session: IHTTPSession): Response {
        val path = session.uri.split("?")[0].trimEnd('/').ifEmpty { "/" }
        val resp = try {
            when {
                path.startsWith("/api/") -> api(path, session)
                path == "/ws" -> newFixedLengthResponse(Status.BAD_REQUEST, "text/plain", "no ws")
                else -> static(path)
            }
        } catch (e: Exception) {
            logLine("500 $path :: ${e.message ?: e.toString()}")
            val j = JSONObject().put("ok", false).put("error", (e.message ?: e.toString()).take(300))
            newFixedLengthResponse(Status.OK, "application/json", j.toString())
        }
        // 本地单窗口: 每个响应都关连接, 避免 keep-alive 复用导致后续请求卡死
        resp.addHeader("Connection", "close")
        return resp
    }

    // ---------- API(形状与 core/server.js 一致) ----------
    private fun api(path: String, session: IHTTPSession): Response {
        val app = ctx.applicationContext as App
        val now = System.currentTimeMillis()
        fun json(o: JSONObject) = newFixedLengthResponse(Status.OK, "application/json", o.toString())
        fun body(): String {
            // 手机为主存储: 请求体按【原始字节流 UTF-8】解码, 规避 NanoHTTPD parseBody
            // 对无 charset 的 application/json 默认解码导致的乱码。
            // 必须只读 Content-Length 个字节: keep-alive 连接下流没有 EOF, 读到流尾会永久阻塞。
            val len = session.headers["content-length"]?.toIntOrNull() ?: -1
            if (len in 1 until 16 * 1024 * 1024) {
                try {
                    val bytes = ByteArray(len)
                    var off = 0
                    val ins = session.inputStream
                    while (off < len) {
                        val n = ins.read(bytes, off, len - off)
                        if (n < 0) break
                        off += n
                    }
                    val raw = String(bytes, 0, off, Charsets.UTF_8)
                    if (raw.indexOf('\uFFFD') >= 0) logLine("BODY-FFFD $path (len=$off)")
                    return raw
                } catch (_: Exception) { }
            }
            // 无长度/超限(如 chunked)→ 交给 NanoHTTPD 自身解析
            val files = HashMap<String, String>()
            try {
                session.parseBody(files)
            } catch (_: Exception) { }
            return files["postData"] ?: ""
        }

        return when {
            path == "/api/health" -> json(JSONObject().put("ok", true).put("app", "待办提醒")
                .put("version", "phone-1.0.0").put("time", now)
                .put("total", app.store.all().size).put("active", app.store.active().size))

            path == "/api/todos" -> json(JSONObject().put("todos", JSONArray().also { a ->
                app.store.all().forEach { a.put(com.todoreminder.web.data.Todo.toJson(it)) }
            }).put("serverTime", now))

            path == "/api/periods" -> json(JSONObject().put("periods", JSONArray().also { a ->
                app.periodStore.all().forEach { a.put(com.todoreminder.web.data.Period.toJson(it)) }
            }).put("serverTime", now))

            path == "/api/sync" && session.method == Method.POST -> {
                val j = JSONObject(body())
                val applied = JSONArray()
                val inc = mutableListOf<com.todoreminder.web.data.Todo>()
                val arr = j.optJSONArray("todos") ?: JSONArray()
                for (i in 0 until arr.length()) {
                    val t = com.todoreminder.web.data.Todo.fromJson(arr.getJSONObject(i))
                    inc += t; applied.put(t.id)
                }
                app.store.upsert(inc)
                onDataChanged.run()
                json(JSONObject().put("todos", JSONArray().also { a ->
                    app.store.all().forEach { a.put(com.todoreminder.web.data.Todo.toJson(it)) }
                }).put("serverTime", now).put("applied", applied))
            }

            path == "/api/periods/sync" && session.method == Method.POST -> {
                val j = JSONObject(body())
                val applied = JSONArray()
                val inc = mutableListOf<com.todoreminder.web.data.Period>()
                val arr = j.optJSONArray("periods") ?: JSONArray()
                for (i in 0 until arr.length()) {
                    val p = com.todoreminder.web.data.Period.fromJson(arr.getJSONObject(i))
                    inc += p; applied.put(p.id)
                }
                app.periodStore.upsert(inc)
                onDataChanged.run()
                json(JSONObject().put("periods", JSONArray().also { a ->
                    app.periodStore.all().forEach { a.put(com.todoreminder.web.data.Period.toJson(it)) }
                }).put("serverTime", now).put("applied", applied))
            }

            path == "/api/export" -> json(JSONObject().put("ok", true).put("exportedAt", now)
                .put("version", "phone-1.0.0")
                .put("todos", JSONArray().also { a -> app.store.all().forEach { a.put(com.todoreminder.web.data.Todo.toJson(it)) } })
                .put("periods", JSONArray().also { a -> app.periodStore.all().forEach { a.put(com.todoreminder.web.data.Period.toJson(it)) } }))

            path == "/api/ai" && session.method == Method.GET -> json(JSONObject().put("ok", true)
                .put("config", aiKit.publicConfig()))

            // 节次对照表: 独立读写 + 版本号(与电脑端同规则), 永久保存在 files/ai.json
            path == "/api/ai/periodtable" && session.method == Method.GET -> json(aiKit.periodTable())

            path == "/api/ai/periodtable" && (session.method == Method.PUT || session.method == Method.POST) -> {
                val j = try { JSONObject(body()) } catch (e: Exception) { JSONObject() }
                json(aiKit.setPeriodTable(j.optString("periodTable"), j.optLong("periodTableAt", 0L)))
            }

            path == "/api/ai" && (session.method == Method.PUT || session.method == Method.POST) -> {
                val raw = body()
                logLine("ai PUT bodylen=" + raw.length)
                val j = try {
                    JSONObject(if (raw.isBlank()) "{}" else raw)
                } catch (e: Exception) {
                    logLine("ai PUT json err: ${e.message}")
                    JSONObject()
                }
                aiKit.save(j)
                json(JSONObject().put("ok", true).put("config", aiKit.publicConfig()))
            }

            path == "/api/ai/parse" -> {
                val j = JSONObject(body())
                val r = try {
                    aiKit.parse(j.optString("image"), j.optString("hint"), j.optString("mode"))
                } catch (e: Exception) {
                    JSONObject().put("ok", false).put("error", (e.message ?: e.toString()).take(300))
                }
                json(r)
            }

            path == "/api/ai/detail" -> {
                val j = JSONObject(body())
                val r = try {
                    aiKit.detail(j.optString("image"), j.optJSONObject("course"))
                } catch (e: Exception) {
                    JSONObject().put("ok", false).put("error", (e.message ?: e.toString()).take(300))
                }
                json(r)
            }

            // 一体包通知自检: 页面「提醒测试」按钮 → 发一条真实系统通知
            path == "/api/native/test-notify" -> {
                val denied = android.os.Build.VERSION.SDK_INT >= 33 &&
                    ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
                    android.content.pm.PackageManager.PERMISSION_GRANTED
                if (denied) {
                    json(JSONObject().put("ok", false)
                        .put("error", "通知权限未开启(Android 13+): 请到 系统设置→通知→允许 后再试"))
                } else {
                    val title = "🔔 待办提醒 · 测试通知"
                    val body = "通知链路正常! 本机时间 " + String.format("%tR", java.util.Date(now)) +
                        " · 若此条能收到, 到点提醒也会正常弹出"
                    com.todoreminder.web.notify.Notifier.show(ctx, (now and 0x7fffffff).toInt(), title, body)
                    logLine("native test-notify sent")
                    json(JSONObject().put("ok", true).put("sentAt", now))
                }
            }

            // 一体包权限状态(页面设置区显示: 后台运行/通知/精确闹钟)
            path == "/api/native/status" -> {
                val sched = com.todoreminder.web.notify.ReminderScheduler
                json(JSONObject()
                    .put("ok", true)
                    .put("batteryIgnoring", sched.isIgnoringBatteryOptimizations(ctx))
                    .put("notifGranted", android.os.Build.VERSION.SDK_INT < 33 ||
                        ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
                        android.content.pm.PackageManager.PERMISSION_GRANTED)
                    .put("exactAlarm", sched.canScheduleExact(ctx)))
            }

            // 一体包「后台运行权限」按钮: 拉起系统授权页/系统弹窗
            path == "/api/native/open-battery" -> {
                try {
                    com.todoreminder.web.notify.ReminderScheduler.openBatteryOptimizationSettings(ctx)
                    logLine("native open-battery requested")
                    json(JSONObject().put("ok", true))
                } catch (e: Exception) {
                    json(JSONObject().put("ok", false)
                        .put("error", (e.message ?: e.toString()).take(200)))
                }
            }

            // 一体包: 把「电脑端连接配置 + 学到的公网入口」告诉页面。
            // 页面据此把 pcUrl/pcToken 写进 localStorage —— 这样远程访问(经同一浏览器打开应用界面)
            // 也能读到该用哪个地址, 而不是只靠原生层的定时同步。
            path == "/api/native/pc-config" -> {
                val p = app.prefs
                val learned = p.pcRemoteUrl
                json(JSONObject()
                    .put("ok", true)
                    .put("url", if (learned.isNotEmpty()) learned else p.pcUrl)
                    .put("token", if (p.pcToken.isNotEmpty()) p.pcToken else "")
                    .put("lastPcUrl", p.pcUrl)
                    .put("remoteUrl", learned)
                    .put("remoteLearnedAt", p.pcRemoteLearnedAt)
                    .put("lastSyncAt", p.lastPcSyncAt))
            }

            else -> newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "not found")
        }
    }

    // ---------- 静态(内嵌 web 资源) ----------
    private fun static(path: String): Response {
        val rel = path.removePrefix("/")
        val f = File(webRoot, rel)
        val file = if (f.isFile) f else File(webRoot, "index.html")
        if (!file.isFile) return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "missing " + path)
        var content = file.readBytes()
        if (file.name == "index.html") {
            // 一体包: 关闭 WebSocket(本地单窗口轮询足够)
            val html = String(content, Charsets.UTF_8)
            if (!html.contains("__NO_WS__")) {
                val out = html.replace("</head>", "<script>window.__NO_WS__=1;</script></head>")
                content = out.toByteArray(Charsets.UTF_8)
            }
        }
        val mime = mimeOf(file.name)
        val resp = newFixedLengthResponse(Status.OK, mime, java.io.ByteArrayInputStream(content), content.size.toLong())
        resp.addHeader("Cache-Control", "no-store")
        return resp
    }

    private fun mimeOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html; charset=utf-8"
        "js" -> "text/javascript; charset=utf-8"
        "css" -> "text/css; charset=utf-8"
        "json", "webmanifest" -> "application/manifest+json; charset=utf-8"
        "png" -> "image/png"
        "ico" -> "image/x-icon"
        "svg" -> "image/svg+xml"
        "txt" -> "text/plain; charset=utf-8"
        else -> "application/octet-stream"
    }

    companion object {
        private const val WEB_VERSION_FILE = ".web-version"

        /**
         * 把 APK 内 assets/web 释放到 filesDir/web。
         * 版本号感知: 首次运行解压并记录版本; App 升级后(或标记缺失时)自动整包刷新,
         * 避免“App 已升级但页面仍是旧版”导致的旧 bug 残留(只动 web/, 不碰 todos/periods/ai)。
         */
        fun prepareWebDir(ctx: Context) {
            val out = ctx.filesDir.web()
            val curCode = try {
                ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionCode
            } catch (_: Exception) { -1 }
            if (out.exists() && out.listFiles()?.isNotEmpty() == true) {
                val oldCode = try {
                    File(out, WEB_VERSION_FILE).readText().trim().toIntOrNull() ?: -1
                } catch (_: Exception) { -1 }
                if (oldCode == curCode) return // 同版本已释放过
                out.deleteRecursively()          // 版本变了 → 旧页面整包替换
            }
            out.mkdirs()
            fun walk(dir: String, relDir: File) {
                val names = ctx.assets.list(dir) ?: return
                for (n in names) {
                    val src = if (dir.isEmpty()) n else "$dir/$n"
                    val dst = File(relDir, n)
                    if (ctx.assets.list(src)?.isNotEmpty() == true) { // 目录
                        dst.mkdirs(); walk(src, dst)
                    } else {
                        dst.parentFile?.mkdirs()
                        ctx.assets.open(src).use { i -> dst.outputStream().use { o -> i.copyTo(o) } }
                    }
                }
            }
            walk("web", out)
            try { File(out, WEB_VERSION_FILE).writeText(curCode.toString()) } catch (_: Exception) { }
        }

        private fun File.web(): File = File(this, "web")
    }
}
