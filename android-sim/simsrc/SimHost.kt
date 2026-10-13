// ============================================================
// SimHost.kt — “安卓环境”JVM 模拟: 用真实 android-web 服务端源码
// (LocalServer.kt + NanoHTTPD 2.3.1 + org.json) 跑在 JVM 上, 提供与手机
// 完全一致的本地 API/页面(__NO_WS__ 注入、Connection: close 等)。
// 先自测 HTTP 序列(中文/emoji 字节保真 + 连续多次保存不卡), 然后常驻供
// 外部(如 Electron 390×844 窗口跑同一套 web 引擎)继续压测保存序列。
//
// 运行: java -Dsim.port=18792 -Dsim.base=android-sim/data -cp ... SimHostKt
// ============================================================
package com.todoreminder.web

import android.content.Context
import android.content.pm.PackageManager
import android.content.res.AssetManager
import com.todoreminder.web.data.Period
import com.todoreminder.web.data.PeriodStore
import com.todoreminder.web.data.Todo
import com.todoreminder.web.data.TodoStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.time.Duration

/** 一体包 App 的替身: 既是 Context 又是 applicationContext(LocalServer 会强转成 App) */
class App(private val base: File) : Context() {
    lateinit var store: TodoStore
    lateinit var periodStore: PeriodStore
    override fun getFilesDir(): File = base
    override fun getApplicationContext(): Context = this
    override fun getAssets(): AssetManager = AssetManager()
    override fun getPackageName(): String = "com.todoreminder.web"
    override fun getPackageManager(): PackageManager = PackageManager()
}

private var pass = 0
private var fail = 0
private fun check(name: String, cond: Boolean, extra: String = "") {
    println((if (cond) "✅ PASS" else "❌ FAIL") + " $name" + if (extra.isEmpty()) "" else " — $extra")
    if (cond) pass++ else fail++
    System.out.flush()
}

fun main() {
    val port = System.getProperty("sim.port")?.toIntOrNull() ?: 18792
    val base = File(System.getProperty("sim.base") ?: "android-sim/data").absoluteFile
    val webSrc = File(System.getProperty("sim.web") ?: "web").absoluteFile
    base.mkdirs()
    val webDir = File(base, "web")
    if (!webDir.exists() || webDir.listFiles()?.isEmpty() == true) {
        webDir.mkdirs()
        Files.walk(webSrc.toPath()).use { s ->
            s.filter { Files.isRegularFile(it) }.forEach { src ->
                val rel = webSrc.toPath().relativize(src)
                val dst = webDir.toPath().resolve(rel)
                Files.createDirectories(dst.parent)
                Files.copy(src, dst)
            }
        }
        println("web 资源已复制到 $webDir")
    }

    val app = App(base)
    app.store = TodoStore(app)
    app.periodStore = PeriodStore(app)
    val srv = LocalServer(port, app, Runnable { })
    srv.start(10000, false)
    println("SIM-READY http://127.0.0.1:$port  data=$base")
    System.out.flush()

    // ---------- HTTP 序列(模拟 WebView 的连续保存) ----------
    val client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
        .connectTimeout(Duration.ofSeconds(5)).build()
    fun call(method: String, path: String, body: String? = null): Triple<Long, Int, String> {
        val t0 = System.currentTimeMillis()
        val rb = HttpRequest.newBuilder(URI.create("http://127.0.0.1:$port$path"))
            .timeout(Duration.ofSeconds(10))
        if (method == "POST") {
            rb.header("content-type", "application/json")
            rb.POST(HttpRequest.BodyPublishers.ofString(body ?: "{}", StandardCharsets.UTF_8))
        } else rb.GET()
        val resp = client.send(rb.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
        val ms = System.currentTimeMillis() - t0
        return Triple(ms, resp.statusCode(), resp.body())
    }

    try {
        // 1) 首页 + __NO_WS__ 注入
        val (t1, c1, h1) = call("GET", "/")
        check("GET / 200 且含 __NO_WS__ 与标题", c1 == 200 && h1.contains("__NO_WS__") && h1.contains("待办提醒"), "${t1}ms")

        // 2) 连续 3 次 POST /api/sync(含中文+emoji 4字节字符), 模拟: 新建→编辑→再新建
        val now = System.currentTimeMillis()
        fun todo(id: String, title: String, updatedAt: Long): JSONObject {
            val o = JSONObject()
            o.put("id", id); o.put("title", title); o.put("notes", "备注·安卓模拟")
            o.put("location", "手机本地教室101")
            o.put("dueAt", JSONObject.NULL); o.put("importance", 1)
            o.put("materials", JSONArray().put("材料甲📦").put("书本乙"))
            o.put("durationMin", JSONObject.NULL); o.put("slotId", "")
            o.put("independent", true); o.put("status", "todo")
            o.put("remindBeforeMin", 10); o.put("repeat", "none"); o.put("fuzzy", false)
            o.put("createdAt", now); o.put("updatedAt", updatedAt); o.put("deleted", false)
            return o
        }
        val seq = listOf(
            "s1-新建" to todo("sim-t1", "安卓中文待办📱甲(首条)", now),
            "s2-再新建" to todo("sim-t2", "乙·第二件 数据优先存手机", now + 1),
            "s3-编辑第一条" to todo("sim-t1", "甲-已修改✅含符号", now + 2),
        )
        for ((name, rec) in seq) {
            val body = JSONObject().put("todos", JSONArray().put(rec)).toString()
            val (ms, code, txt) = call("POST", "/api/sync", body)
            val j = try { JSONObject(txt) } catch (e: Exception) { null }
            val echoOk = j != null && j.optJSONArray("todos") != null &&
                j.optJSONArray("todos").toString().contains(rec.optString("title"))
            check("POST /api/sync $name 不回卡且中文原样回显", code == 200 && echoOk && ms < 3000, "${ms}ms")
        }

        // 3) 时段库带中文
        val pnow = System.currentTimeMillis()
        val per = JSONObject()
        per.put("id", "sim-p1"); per.put("name", "晚自习专注📖"); per.put("idleName", "")
        per.put("startMin", 19 * 60 + 30); per.put("endMin", 21 * 60)
        per.put("nodes", JSONArray().put(JSONObject().put("startMin", 19 * 60 + 30).put("endMin", 21 * 60)))
        per.put("env", "书桌"); per.put("priority", 1); per.put("remindBeforeMin", 10)
        per.put("freq", "daily"); per.put("weekdays", JSONArray())
        per.put("monthDay", JSONObject.NULL); per.put("startMD", JSONObject.NULL); per.put("endMD", JSONObject.NULL)
        per.put("colorSlot", JSONObject.NULL)
        per.put("createdAt", pnow); per.put("updatedAt", pnow); per.put("deleted", false)
        val pb = JSONObject().put("periods", JSONArray().put(per)).toString()
        val (msP, cP, txtP) = call("POST", "/api/periods/sync", pb)
        check("POST /api/periods/sync 中文不卡", cP == 200 && txtP.contains("晚自习专注📖") && msP < 3000, "${msP}ms")

        // 4) 回读全量: 逐字节保真 + 无替换符
        val (msT, cT, txtT) = call("GET", "/api/todos")
        val clean = !txtT.contains('\uFFFD')
        val all = try { JSONObject(txtT).optJSONArray("todos")?.length() ?: -1 } catch (e: Exception) { -1 }
        check("GET /api/todos 回读无 U+FFFD 且 3 条全在",
            cT == 200 && clean && all == 3 && txtT.contains("甲-已修改✅含符号") && txtT.contains("安卓中文待办📱甲(首条)"), "${msT}ms n=$all")

        // 5) 响应头 Connection: close 生效(v1.0.21 加固)
        val req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:$port/api/health")).GET().build()
        val resp = client.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
        val connHdr = resp.headers().firstValue("Connection").orElse("(无)")
        check("响应头 Connection: close", connHdr.equals("close", ignoreCase = true), connHdr)
    } catch (e: Exception) {
        println("❌ 序列异常: " + (e.message ?: e.toString()))
        fail++
    }

    println("HTTP 序列结果: PASS=$pass FAIL=$fail")
    println("SIM-KEEPALIVE 继续常驻(供页面端保存序列测试)…")
    System.out.flush()
    Thread.sleep(Long.MAX_VALUE)
}
