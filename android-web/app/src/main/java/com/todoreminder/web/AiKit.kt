package com.todoreminder.web

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * 手机端 AI 识图(截图→待办/课表 与 课程详情补全)。
 * 与电脑端 core/server.js 的解析规则保持一致:
 *   · 内置默认连接配置(直接写入软件), 可用 files/ai.json 覆盖
 *   · OpenAI 兼容 /chat/completions, 图片走 dataURL
 *   · JSON 不完整时自动重试一次(强调“完整未截断”)
 *   · 课表忽略“日语”; 支持节次时间表(periodTable)与逐课修正行(courseFix)
 */
class AiKit(private val ctx: Context) {

    private data class Cfg(
        var baseUrl: String, var model: String, var apiKey: String,
        var periodTable: String, var courseFix: String,
        var periodTableAt: Long = 0,
    )

    private val defaults = Cfg(
        baseUrl = "https://api.deepseek.com/v1",
        model = "deepseek-v4-flash-vision-exp",
        apiKey = "<FILL_ME>",
        periodTable = listOf(
            "第1节 08:50-09:10", "第2节 09:15-09:55", "第3节 10:20-11:00", "第4节 11:05-11:45",
            "第5节 13:50-14:30", "第6节 14:55-15:15", "第7节 15:50-16:10", "第8节 16:15-16:55",
            "第9节 18:50-19:10", "第10节 19:15-19:55", "第11节 20:10-20:50",
        ).joinToString("\n"),
        courseFix = "周三|大数据导论|18:50-19:55",
    )

    @Synchronized
    private fun cfg(): Cfg {
        val c = defaults.copy()
        try {
            val f = File(ctx.filesDir, "ai.json")
            if (f.exists()) {
                val j = JSONObject(f.readText())
                if (j.optString("baseUrl").isNotBlank()) c.baseUrl = j.optString("baseUrl")
                if (j.optString("model").isNotBlank()) c.model = j.optString("model")
                if (j.has("apiKey")) c.apiKey = j.optString("apiKey") // 允许显式留空清除
                if (j.has("periodTable")) c.periodTable = j.optString("periodTable")
                if (j.has("periodTableAt")) c.periodTableAt = j.optLong("periodTableAt", 0L)
                if (j.has("courseFix")) c.courseFix = j.optString("courseFix")
            }
        } catch (_: Exception) { }
        if (c.periodTableAt <= 0L && c.periodTable.trim().isNotEmpty()) c.periodTableAt = 1L // 老数据兼容
        return c
    }

    @Synchronized
    fun save(body: JSONObject) {
        val c = cfg()
        val base = body.optString("baseUrl")
        if (base.matches(Regex("^https?://"))) c.baseUrl = base.trimEnd('/')
        if (body.optString("model").isNotBlank()) c.model = body.optString("model").trim()
        if (body.has("apiKey")) c.apiKey = body.optString("apiKey").trim()
        // 节次表只有“带版本号”的明确提交才写入 —— 设置页旧缓存/空值不会覆盖已保存内容
        if (body.has("periodTable") && body.has("periodTableAt")) {
            c.periodTable = normPt(body.optString("periodTable"))
            c.periodTableAt = body.optLong("periodTableAt", 0L)
        }
        if (body.has("courseFix")) {
            c.courseFix = body.optString("courseFix").split("\n").map { it.trim() }.filter { it.isNotEmpty() }.take(60).joinToString("\n")
        }
        try {
            File(ctx.filesDir, "ai.json").writeText(JSONObject()
                .put("baseUrl", c.baseUrl).put("model", c.model).put("apiKey", c.apiKey)
                .put("periodTable", c.periodTable).put("periodTableAt", c.periodTableAt)
                .put("courseFix", c.courseFix).toString())
        } catch (_: Exception) { }
    }

    /** 节次对照表读取(供客户端启动/同步时对齐) */
    fun periodTable(): JSONObject {
        val c = cfg()
        return JSONObject().put("ok", true).put("periodTable", c.periodTable).put("periodTableAt", c.periodTableAt)
    }

    /** 节次对照表写入: 只有版本号更新的才生效(LWW), 避免旧内容回滚; 空内容默认忽略 */
    fun setPeriodTable(text: String?, at: Long): JSONObject {
        val c = cfg()
        val clean = normPt(text)
        if (clean.isEmpty()) {
            return JSONObject().put("ok", true).put("adopted", false).put("reason", "empty-ignored")
                .put("periodTable", c.periodTable).put("periodTableAt", c.periodTableAt)
        }
        if (at > 0L && at > c.periodTableAt) {
            c.periodTable = clean
            c.periodTableAt = at
            try {
                File(ctx.filesDir, "ai.json").writeText(JSONObject()
                    .put("baseUrl", c.baseUrl).put("model", c.model).put("apiKey", c.apiKey)
                    .put("periodTable", c.periodTable).put("periodTableAt", c.periodTableAt)
                    .put("courseFix", c.courseFix).toString())
            } catch (_: Exception) { }
            return JSONObject().put("ok", true).put("adopted", true)
                .put("periodTable", c.periodTable).put("periodTableAt", c.periodTableAt)
        }
        return JSONObject().put("ok", true).put("adopted", false)
            .put("periodTable", c.periodTable).put("periodTableAt", c.periodTableAt)
    }

    private fun normPt(v: String?): String =
        (v ?: "").split("\n").map { it.trim() }.filter { it.isNotEmpty() }.take(30).joinToString("\n")

    fun publicConfig(): JSONObject {
        val c = cfg()
        return JSONObject()
            .put("baseUrl", c.baseUrl)
            .put("model", c.model)
            .put("hasKey", c.apiKey.isNotEmpty())
            .put("periodTable", c.periodTable)
            .put("periodTableAt", c.periodTableAt)
            .put("courseFix", c.courseFix)
    }

    // ---------- 对外接口 ----------

    /** 返回 {ok, fields|error} 或抛错(网络类); mode: auto/timetable/todo/periodtable */
    fun parse(image: String, hint: String, mode: String = "auto"): JSONObject {
        val c = cfg()
        if (c.apiKey.isEmpty()) return err("尚未填写 AI API Key: 设置 → 🤖 AI 建任务")
        if (!Regex("^data:image/(png|jpe?g|webp|gif);base64,", RegexOption.IGNORE_CASE).containsMatchIn(image)) {
            return err("缺少图片(需 dataURL 格式)")
        }
        val periodRule = c.periodTable.trim()
        val periodHint = if (periodRule.isNotEmpty())
            "\n[本校节次时间对照表, 请优先按它把“第X节/第X-Y节”换算成钟点; 若图中直接写明钟点则以图中为准]\n${periodRule.take(800)}"
        else
            "\n[若课表只写“第X节/第X-Y节”且图中没有钟点: 默认按第1节 08:00 起、每节 45 分钟换算; 若与实际不符, 请到设置把学校节次时间表填入]"
        val sys: String
        val ut: String
        when (mode) {
            "timetable" -> { sys = AI_TIMETABLE_SYSTEM; ut = "现在本地时间: ${nowText()}。请按【课表识别】规则处理这张截图。$periodHint" }
            "todo" -> { sys = AI_TODO_SYSTEM; ut = "现在本地时间: ${nowText()}。请按【日常事项识别】规则处理这张截图。" }
            "periodtable" -> { sys = AI_PERIODTABLE_SYSTEM; ut = "现在本地时间: ${nowText()}。请按【节次对照表识别】规则处理这张截图。" }
            else -> { sys = AI_SYSTEM; ut = "现在本地时间: ${nowText()}。请分析这张截图: 是课程表就按课表输出 kind=timetable, 否则按普通待办输出 kind=todo。$periodHint" }
        }
        val userText = ut + hint

        var raw: JSONObject
        try {
            raw = chatJson(c, image, userText, sys)
        } catch (e1: Exception) {
            val m1 = e1.message ?: ""
            if (!Regex("JSON|array element|unexpected|token|length", RegexOption.IGNORE_CASE).containsMatchIn(m1)) throw e1
            raw = chatJson(c, image, userText + "\n[上次输出不是完整的JSON, 请重新输出: 只输出一个完整的、未截断的JSON对象, 不要任何多余文字]", sys)
        }
        val s = { v: Any? -> if (v is String) v.trim() else "" }
        fun num(v: Any?): Int? = if (v is Number) Math.round(v.toDouble()).toInt() else null

        // ---------- 节次对照表识别(periodtable) ----------
        if (mode == "periodtable") {
            val rows = JSONArray()
            val lines = JSONArray()
            val seen = HashSet<String>()
            val ra = raw.optJSONArray("rows") ?: raw.optJSONArray("items") ?: JSONArray()
            val re = Regex("(\\d{1,2}):(\\d{2})\\s*[-–—~至]\\s*(\\d{1,2}):(\\d{2})")
            for (i in 0 until ra.length()) {
                val r = ra.optJSONObject(i) ?: continue
                val label = s(r.opt("label")).ifEmpty { s(r.opt("name")) }.ifEmpty { s(r.opt("period")) }
                if (label.isEmpty()) continue
                val tmText = s(r.opt("time")).ifEmpty { "${s(r.opt("start"))}-${s(r.opt("end"))}" }.ifEmpty { s(r.opt("range")) }
                val mT = re.find(tmText) ?: continue
                val st = String.format("%02d:%s", mT.groupValues[1].toInt(), mT.groupValues[2])
                val en = String.format("%02d:%s", mT.groupValues[3].toInt(), mT.groupValues[4])
                val key = "$st-$en"
                if (seen.contains(key)) continue
                seen.add(key)
                rows.put(JSONObject().put("label", label).put("start", st).put("end", en))
                lines.put("$label $st-$en")
            }
            if (lines.length() == 0) return err("未识别到节次行 — 请截一张清晰的“节次时间对照表”")
            return JSONObject().put("ok", true).put("fields", JSONObject()
                .put("kind", "periodTable").put("lines", lines).put("rows", rows))
        }

        // ---------- 课表模式 ----------
        val arr = raw.optJSONArray("courses") ?: raw.optJSONArray("items") ?: JSONArray()
        val dayCn = mapOf('一' to 1, '二' to 2, '三' to 3, '四' to 4, '五' to 5, '六' to 6, '日' to 7, '天' to 7)
        val courses = JSONArray()
        for (i in 0 until arr.length()) {
            val c0 = arr.optJSONObject(i) ?: continue
            val name = s(c0.opt("name").takeIf { it != null } ?: c0.opt("title")).take(40)
            if (name.isEmpty()) continue
            if (name.contains("日语")) continue // 日语课程永久忽略(与电脑端一致)
            var day: Int? = num(c0.opt("day"))
            if ((day == null || day !in 1..7) && c0.optString("day").matches(Regex("[1-7]"))) day = c0.optInt("day")
            if (day == null || day !in 1..7) {
                day = 0
                val dn = s(c0.opt("dayName")).ifEmpty { s(c0.opt("dayCn")) }
                for ((k, v) in dayCn) if (dn.contains(k)) { day = v; break }
            }
            if (day == 0) continue
            val startMin = num(c0.opt("startMin"))
            if (startMin == null || startMin < 0 || startMin > 1439) continue
            var endMin = num(c0.opt("endMin"))
            if (endMin == null || endMin <= startMin) endMin = Math.min(1439, startMin + 90)
            val jo = JSONObject()
                .put("name", name)
                .put("day", day)
                .put("startMin", startMin)
                .put("endMin", endMin)
                .put("env", s(c0.opt("location")).ifEmpty { s(c0.opt("room")) }.ifEmpty { s(c0.opt("env")) }.take(60))
            courses.put(jo)
        }
        val isTimetable = raw.optString("kind") == "timetable" || raw.has("courses") || raw.has("items")
        if (mode != "todo" && isTimetable) {
            if (courses.length() == 0) return err("识别为课表但没有提取到课程 — 试试更清晰的整周课表截图")
            for (i in 0 until courses.length()) courses.getJSONObject(i).put("location", courses.getJSONObject(i).optString("env"))
            // courseFix: 每行 “周X|课程名|HH:MM-HH:MM” 强制覆盖
            val fixDay = mapOf('一' to 1, '二' to 2, '三' to 3, '四' to 4, '五' to 5, '六' to 6, '日' to 7)
            val fixRe = Regex("^周([一二三四五六日])\\s*[|｜,，、]\\s*(.+?)\\s*[|｜,，、]\\s*(\\d{1,2}):(\\d{2})\\s*[-–—~至]\\s*(\\d{1,2}):(\\d{2})$")
            for (ln in c.courseFix.split("\n")) {
                val m = fixRe.find(ln.trim()) ?: continue
                val d = fixDay[m.groupValues[1][0]] ?: continue
                val sMin = m.groupValues[3].toInt() * 60 + m.groupValues[4].toInt()
                val eMin = m.groupValues[5].toInt() * 60 + m.groupValues[6].toInt()
                if (eMin <= sMin || eMin > 1440) continue
                val fixName = m.groupValues[2].trim()
                for (i in 0 until courses.length()) {
                    val cj = courses.getJSONObject(i)
                    if (cj.optInt("day") == d && cj.optString("name") == fixName) {
                        cj.put("startMin", sMin).put("endMin", eMin)
                    }
                }
            }
            var mondayIso: String? = null
            val isoText = listOf("mondayIso", "mondayDate", "weekStart", "dateRange", "dateText", "range")
                .mapNotNull { k -> raw.optString(k).takeIf { it.isNotEmpty() } }.joinToString(" ")
            val mIso = Regex("(20\\d{2})[-/.]\\s*(\\d{1,2})[-/.]\\s*(\\d{1,2})").find(isoText)
            if (mIso != null) {
                try {
                    val d0 = LocalDate.of(mIso.groupValues[1].toInt(), mIso.groupValues[2].toInt(), mIso.groupValues[3].toInt())
                    mondayIso = d0.toString()
                } catch (_: Exception) { }
            }
            if (mondayIso != null) {
                val base = LocalDate.parse(mondayIso)
                val fmtHm = DateTimeFormatter.ofPattern("HH:mm")
                for (i in 0 until courses.length()) {
                    val cj = courses.getJSONObject(i)
                    val date = base.plusDays((cj.optInt("day") - 1).toLong()).toString()
                    val sm = cj.optInt("startMin")
                    val em = cj.optInt("endMin")
                    val hm = String.format("%02d:%02d", sm / 60, sm % 60)
                    val due = LocalDateTime.parse(date + "T" + hm).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
                    cj.put("date", date).put("dueAt", due).put("durationMin", em - sm)
                }
            }
            return JSONObject().put("ok", true).put("fields", JSONObject()
                .put("kind", "timetable").put("mondayIso", mondayIso ?: JSONObject.NULL).put("courses", courses))
        }

        // ---------- 普通待办 ----------
        if (mode == "timetable") {
            return err("这张图没识别成课表 — 请上传整周课表截图; 若是节次对照表请用“节次表”模式")
        }
        val fields = JSONObject()
            .put("kind", "todo")
            .put("title", s(raw.opt("title")).take(120).ifEmpty { "截图待办" })
            .put("notes", s(raw.opt("notes")).take(2000))
            .put("location", s(raw.opt("location")).take(120))
            .put("materials", JSONArray().also { a ->
                val ma = raw.optJSONArray("materials")
                if (ma != null) for (i in 0 until ma.length()) {
                    val x = s(ma.opt(i))
                    if (x.isNotEmpty() && a.length() < 20) a.put(x)
                }
            })
        val dur = num(raw.opt("durationMin"))
        fields.put("durationMin", if (dur != null && dur > 0) Math.min(10080, dur) else JSONObject.NULL)
        val imp = num(raw.opt("importance"))
        fields.put("importance", if (imp != null && imp in 0..2) imp else JSONObject.NULL)
        val ind = raw.opt("independent")
        fields.put("independent", if (ind is Boolean) ind else JSONObject.NULL)
        val rep = raw.optString("repeat")
        fields.put("repeat", if (rep == "daily" || rep == "weekly" || rep == "monthly") rep else "none")
        var due: Long? = null
        val iso = s(raw.opt("dueIso"))
        if (iso.isNotEmpty()) {
            try { due = LocalDateTime.parse(iso.replace(" ", "T")).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli() } catch (_: Exception) { }
        }
        fields.put("dueAt", due ?: JSONObject.NULL)
        return JSONObject().put("ok", true).put("fields", fields)
    }

    /** 课程详情补全(第二步) */
    fun detail(image: String, course: JSONObject?): JSONObject {
        val c = cfg()
        if (c.apiKey.isEmpty()) return err("尚未填写 AI API Key: 设置 → 🤖 AI 建任务")
        if (!Regex("^data:image/(png|jpe?g|webp|gif);base64,", RegexOption.IGNORE_CASE).containsMatchIn(image)) {
            return err("缺少图片(需 dataURL 格式)")
        }
        val name = course?.optString("name").orEmpty()
        val date = course?.optString("date").orEmpty()
        val userText = "现在本地时间: ${nowText()}。这张截图是课程「$name」${if (date.isNotEmpty()) "($date)" else ""}的详情/资料, 请按规则提取。"
        var raw: JSONObject
        try {
            raw = chatJson(c, image, userText, AI_DETAIL_SYSTEM)
        } catch (e1: Exception) {
            val m1 = e1.message ?: ""
            if (!Regex("JSON|array element|unexpected|token|length", RegexOption.IGNORE_CASE).containsMatchIn(m1)) throw e1
            raw = chatJson(c, image, userText + "\n[上次输出不是完整的JSON, 请重新输出: 只输出一个完整的、未截断的JSON对象, 不要任何多余文字]", AI_DETAIL_SYSTEM)
        }
        val s = { v: Any? -> if (v is String) v.trim() else "" }
        val f = JSONObject()
            .put("teacher", s(raw.opt("teacher")).take(60))
            .put("textbook", s(raw.opt("textbook")).take(200))
            .put("location", s(raw.opt("location")).take(120))
            .put("materials", JSONArray().also { a ->
                val ma = raw.optJSONArray("materials")
                if (ma != null) for (i in 0 until ma.length()) { val x = s(ma.opt(i)); if (x.isNotEmpty() && a.length() < 20) a.put(x) }
            })
            .put("notes", s(raw.opt("notes")).take(300))
        return JSONObject().put("ok", true).put("fields", f)
    }

    private fun err(msg: String): JSONObject = JSONObject().put("ok", false).put("error", msg.take(300))

    private fun nowText(): String = java.text.SimpleDateFormat("EEE MMM dd yyyy HH:mm:ss 'GMT'Z", java.util.Locale.US)
        .format(java.util.Date())

    // ---------- LLM 调用 ----------
    private fun chatJson(c: Cfg, imageDataUrl: String, userText: String, system: String): JSONObject {
        val url = c.baseUrl.trimEnd('/') + "/chat/completions"
        val body = JSONObject()
            .put("model", c.model)
            .put("temperature", 0.2)
            .put("max_tokens", 4000)
            .put("messages", JSONArray()
                .put(JSONObject().put("role", "system").put("content", system))
                .put(JSONObject().put("role", "user").put("content", JSONArray()
                    .put(JSONObject().put("type", "text").put("text", userText))
                    .put(JSONObject().put("type", "image_url").put("image_url", JSONObject().put("url", imageDataUrl))))))

        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 20000
            conn.readTimeout = 90000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer " + c.apiKey)
            conn.outputStream.use { it.write(body.toString().toByteArray(StandardCharsets.UTF_8)) }
            val code = conn.responseCode
            val ise = conn.inputStream
            val errs = conn.errorStream
            val text = readAll(if (code in 200..299) ise else errs ?: ise)
            if (code !in 200..299) throw Exception("AI 接口返回 $code: ${text.take(200)}")
            val data = JSONObject(text)
            val msg = data.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")
                ?: throw Exception("AI 未返回内容")
            var content = msg.optString("content")
            if (content.isEmpty()) content = msg.optString("reasoning_content") // 部分模型正文在 reasoning
            if (content.isEmpty()) throw Exception("AI 未返回内容")
            var seg = content
            val fence = Regex("```(?:json)?\\s*([\\s\\S]*?)```").find(content)
            if (fence != null) seg = fence.groupValues[1]
            val st = seg.indexOf('{')
            val en = seg.lastIndexOf('}')
            if (st < 0 || en <= st) throw Exception("AI 未输出可解析 JSON")
            return JSONObject(seg.substring(st, en + 1))
        } finally {
            conn.disconnect()
        }
    }

    private fun readAll(input: InputStream): String {
        input.use { ins ->
            val bos = ByteArrayOutputStream()
            val buf = ByteArray(8192)
            var n: Int
            while (ins.read(buf).also { n = it } > 0) bos.write(buf, 0, n)
            return bos.toString("UTF-8")
        }
    }

    companion object {
        private val AI_SYSTEM = listOf(
            "你是“待办提醒”应用的截图解析助手。用户会发来一张截图,可能是: ①普通信息(聊天/通知/票证/公告/便签…)要提取一条待办; ②学校/单位的“课程表/课表”(通常是表格,含星期几、节次/钟点、课程名、教室)。",
            "先判断是哪一种。只输出一个 JSON 对象(不要 markdown、不要解释)。",
            "情况A 是课表时输出:",
            "{ \"kind\": \"timetable\", \"mondayIso\": \"图中该周“周一”的日期, 格式 YYYY-MM-DD(例如图顶写着 第2周 2026-09-14/2026-09-20 → 填 2026-09-14; 没有日期信息则填 null)\", \"courses\": [",
            "  { \"name\": \"课程名(≤40字)\", \"day\": 1到7(周一=1…周日=7), \"startMin\": 当天0点起分钟数(如8:00=480), \"endMin\": 结束分钟数(如9:40=580), \"location\": \"地点, 没有则空串\" }",
            "] }",
            "课表色块/格子里通常第一行是课程名、下一行是地点。请只把“课程名”填进 name,把地点(教室/楼栋/场所)单独填进 location;格子里的老师姓名、备注等杂讯不要混入 name 或 location。",
            "课程的“重要程度”由应用统一默认设为中,不要输出 importance。",
            "时间换算规则: 截图写了钟点就直接换算分钟; 只写节次且无钟点参照时按 prompt 中的对照表或常见默认换算; 无法推断的课程跳过。每个课程都要有 day 与 startMin。",
            "情况B 不是课表时输出:",
            "{ \"kind\": \"todo\", \"title\": \"简短标题(必填)\", \"notes\": \"补充说明或空串\", \"location\": \"地点或空串\",",
            " \"materials\": [\"所需材料\"], \"durationMin\": 数字或 null, \"importance\": 0或1或2或null,",
            " \"independent\": true或false或null, \"repeat\": \"none|daily|weekly|monthly\"或null(明确写“每天/每周X/每月X号”才填),",
            " \"dueIso\": \"YYYY-MM-DDTHH:mm\"(按用户所在本地时间, 没有则为 null; 每周X/每月X号→下一次对应日期且配合 repeat) }",
            "重要: 地点一律放 location; 每周/每月/每天重复规律放 repeat+dueIso, 两者都不许写进 notes。",
        ).joinToString("\n")

        private val AI_DETAIL_SYSTEM = listOf(
            "你是“待办提醒”应用的“课程详情”解析助手。用户会发一张课程详情截图。",
            "提取与课程相关的: 任课老师、教材/资料、上课/作业要求、考试安排等, 输出一个JSON对象(不要markdown):",
            "{ \"teacher\": \"任课老师名(无则空串)\", \"textbook\": \"教材或资料名(无则空串)\", \"location\": \"地点/教室(如截图有且需要修正则填, 否则空串)\",",
            "  \"materials\": [\"需要携带的物品/资料\"], \"notes\": \"其它说明(作业/要求/考试等, ≤300字, 无则空串)\" }",
            "只提取截图里真实出现的信息, 不确定的字段填空串。",
        ).joinToString("\n")

        private val AI_TIMETABLE_SYSTEM = listOf(
            "你是“待办提醒”应用的【课表识别】助手。这张截图是学校/单位的课程表(通常含星期几、节次/钟点、课程名、教室)。",
            "只输出一个 JSON 对象(不要 markdown、不要解释):",
            "{ \"kind\": \"timetable\", \"mondayIso\": \"图中该周“周一”的日期 YYYY-MM-DD(没有则 null)\", \"courses\": [",
            "  { \"name\": \"课程名(≤40字)\", \"day\": 1到7(周一=1…周日=7), \"startMin\": 当天0点起分钟数(如8:00=480), \"endMin\": 结束分钟数(如9:40=580), \"location\": \"地点/教室, 没有则空串\" }",
            "] }",
            "只把课程名填进 name, 地点单独填进 location; 老师姓名等杂讯不要混入。",
            "按图中写明钟点换算; 只写“第X节”时严格按提示里给出的节次对照表换算(无对照表按第1节08:00起每节45分钟连续相加)。",
            "若截图不是课表或提取不到课程: 输出 { \"kind\": \"timetable\", \"mondayIso\": null, \"courses\": [] }。",
        ).joinToString("\n")

        private val AI_TODO_SYSTEM = listOf(
            "你是“待办提醒”应用的【日常事项识别】助手。截图是普通信息(聊天/通知/票证/公告/便签/快递单…), 提取“一条待办”。",
            "只输出一个 JSON 对象(不要 markdown):",
            "{ \"kind\": \"todo\", \"title\": \"简短标题(≤40字, 必填)\", \"notes\": \"补充说明或空串\", \"location\": \"地点或空串\",",
            " \"materials\": [\"所需材料\"], \"durationMin\": 数字或 null, \"importance\": 0或1或2或null,",
            " \"independent\": true或false或null, \"repeat\": \"none|daily|weekly|monthly\"或null(明确写“每天/每周X/每月X号”才填),",
            " \"dueIso\": \"YYYY-MM-DDTHH:mm\"(按用户本地时间; 每周X→下一次该星期且 repeat=weekly; 每月X号→下一次该日且 repeat=monthly; 没有则 null) }",
            "重要: 地点一律放 location; 重复规律放 repeat+dueIso; 两者都不许写进 notes。",
            "即使截图像课表也忽略: 本模式只提取待办。",
        ).joinToString("\n")

        private val AI_PERIODTABLE_SYSTEM = listOf(
            "你是“待办提醒”应用的【节次对照表识别】助手。这张截图是“节次时间对照表”(每行形如: 第1节 08:00-08:45 或 第1-2节 08:00-09:20)。",
            "只输出一个 JSON 对象(不要 markdown):",
            "{ \"kind\": \"periodTable\", \"rows\": [ { \"label\": \"第1节\", \"start\": \"08:00\", \"end\": \"08:45\" }, ... ] }",
            "label 写“第X节”或“第X-Y节”; start/end 写 24 小时制 HH:mm; 连堂按图中一整行处理, 不拆开。",
            "若截图不是节次对照表: 输出 { \"kind\": \"periodTable\", \"rows\": [] }。",
        ).joinToString("\n")
    }
}
