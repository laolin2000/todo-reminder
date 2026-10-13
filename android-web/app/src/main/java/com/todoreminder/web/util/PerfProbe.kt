package com.todoreminder.web.util

import java.io.File
import kotlin.jvm.Synchronized
import kotlin.jvm.Volatile

/**
 * 轻量资源自检: 后台运行期间周期采样 进程 CPU / 内存 RSS / 堆, 并累计
 * 应用层同步流量(自动/手动同步上传字节)。结果供 ⚙→诊断信息 展示,
 * 用于回答“后台全权限运行时占多少性能”。无需任何额外权限(/proc 自读)。
 */
object PerfProbe {
    data class Sample(val at: Long, val cpuPct: Double, val rssMb: Long, val heapMb: Double)

    private const val KEEP = 120 // 30s × 120 ≈ 1 小时

    @Volatile private var lastMe: LongArray? = null   // [utime, stime]
    @Volatile private var lastSampleMs = 0L
    private val samples = ArrayDeque<Sample>()

    @Volatile var upBytes = 0L      // 应用层累计上传字节(自动/手动同步)
    @Volatile var syncRuns = 0      // 同步尝试次数(成功与否分开统计)
    @Volatile var syncOk = 0

    private fun readMe(): LongArray? {
        return try {
            val t = File("/proc/self/stat").readText()
            val lp = t.lastIndexOf(')')
            if (lp < 0) null
            else {
                val rest = t.substring(lp + 1).trim().split(Regex("\\s+"))
                // 去掉 "pid (comm)" 后: rest[0]=state(字段3); 字段14/15 = utime/stime → rest[11]/[12]
                if (rest.size < 13) null
                else {
                    val utime = rest[11].toLongOrNull() ?: 0L
                    val stime = rest[12].toLongOrNull() ?: 0L
                    longArrayOf(utime, stime)
                }
            }
        } catch (_: Exception) { null }
    }

    /** 内存占用: 优先 /proc/self/status VmRSS; Android 10+ 受限时用 Debug.getPss() 兜底 */
    fun rssMb(): Long {
        try {
            val v = File("/proc/self/status").readText().lineSequence()
                .firstOrNull { it.startsWith("VmRSS") }?.substringAfter(':')?.trim()
                ?.substringBefore(' ')?.toLongOrNull()
            if (v != null && v > 0) return v / 1024
        } catch (_: Exception) { }
        return try {
            val pssKb = android.os.Debug.getPss()   // KB, 兜底
            if (pssKb > 0) pssKb / 1024 else -1L
        } catch (_: Exception) { -1L }
    }

    fun heapMb(): Double =
        (Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory()) / 1048576.0

    /**
     * 采样一次。CPU 采用“进程 jiffies 增量 ÷ 墙钟增量”(单核基准, 100% = 占满一个核),
     * 不再依赖 /proc/stat —— Android 10+ 对普通应用限制读取全局 CPU 统计,
     * 之前正是因此一直显示“采样中”。
     */
    @Synchronized
    fun tick() {
        val me = readMe()
        val now = System.currentTimeMillis()
        val prevMe = lastMe
        val prevMs = lastSampleMs
        lastMe = me
        lastSampleMs = now
        if (me == null || prevMe == null) return
        val dMs = now - prevMs
        if (dMs < 15000) return
        val procTicks = (me[0] - prevMe[0]) + (me[1] - prevMe[1])   // jiffies, USER_HZ=100 → 10ms
        if (procTicks < 0) return
        val cpu = procTicks * 10.0 / dMs * 100.0                    // 单核百分比
        samples.addLast(Sample(now, cpu.coerceIn(0.0, 100.0 * 8), rssMb(), heapMb()))
        while (samples.size > KEEP) samples.removeFirst()
    }

    @Synchronized
    fun addUpBytes(n: Int) { upBytes += n }

    @Synchronized
    fun noteSync(ok: Boolean) { syncRuns++; if (ok) syncOk++ }

    @Synchronized
    fun summary(): String {
        val avgCpu = if (samples.isEmpty()) -1.0
        else samples.map { it.cpuPct }.average()
        val last = samples.lastOrNull()
        val rss = last?.rssMb ?: rssMb()
        val heap = last?.heapMb ?: heapMb()
        val sb = StringBuilder()
        sb.append("进程CPU≈")
        if (avgCpu < 0) sb.append("采样中(约1分钟后出数)")
        else sb.append(String.format(java.util.Locale.CHINA, "%.1f%%", avgCpu)).append("(后台平均)")
        sb.append(" · 内存RSS≈").append(if (rss > 0) (rss / 1024.0).let { String.format(java.util.Locale.CHINA, "%.0fMB", it) } else "?")
        sb.append(" · 堆≈").append(String.format(java.util.Locale.CHINA, "%.0fMB", heap))
        sb.append(" · 同步流量↑≈").append(String.format(java.util.Locale.CHINA, "%.0fKB", upBytes / 1024.0))
        sb.append(" · 同步").append(syncOk).append("/").append(syncRuns).append("次")
        sb.append(" · 采样").append(samples.size).append("个(30s周期)")
        return sb.toString()
    }
}
