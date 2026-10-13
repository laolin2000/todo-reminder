package com.todoreminder.web.util

import com.todoreminder.web.data.Todo
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/** 时间/时长展示与日期分桶(与电脑端一致) */
object Fmt {
    private val hmF = SimpleDateFormat("HH:mm", Locale.getDefault())
    private val mdF = SimpleDateFormat("M月d日 HH:mm", Locale.getDefault())
    private val ymdF = SimpleDateFormat("yyyy年M月d日 HH:mm", Locale.getDefault())

    fun dueText(t: Todo, nowMs: Long = System.currentTimeMillis()): String {
        val ts = t.dueAt ?: return ""
        val d = Date(ts)
        val c = Calendar.getInstance().apply { timeInMillis = nowMs }
        val dayStart = Calendar.getInstance().apply {
            timeInMillis = nowMs
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }
        val dayIndex = ((dayStartOf(ts) - dayStart.timeInMillis) / 86400000L).toInt()
        val hm = hmF.format(d)
        return when {
            dayIndex == 0 -> "今天 $hm"
            dayIndex == 1 -> "明天 $hm"
            else -> if (d.year + 1900 == c.get(Calendar.YEAR)) mdF.format(d) else ymdF.format(d)
        }
    }

    fun isOverdue(t: Todo, nowMs: Long = System.currentTimeMillis()): Boolean {
        if (t.isDone || t.dueAt == null) return false
        val end = endAt(t) ?: return false
        return nowMs >= end
    }

    /** 结束时刻 = 开始 + 所需时长; 未填时长视为“开始即结束”(与电脑端一致) */
    fun endAt(t: Todo): Long? {
        val due = t.dueAt ?: return null
        val dur = (t.durationMin ?: 0).coerceAtLeast(0)
        return due + dur * 60000L
    }

    /**
     * 生命周期状态(派生, 与电脑端 model.js lifeStatus 一致):
     * done→已完成; 未到开始→todo; 已到开始未到结束→doing; 过了结束→overdue。
     */
    fun life(t: Todo, nowMs: Long = System.currentTimeMillis()): String {
        if (t.isDone) return "done"
        if (t.status == "doing") return "doing" // 手动“进行中”优先(逾期事项可改回进行中)
        val due = t.dueAt ?: return "todo"
        val end = endAt(t) ?: due
        return when {
            nowMs < due -> "todo"
            nowMs < end -> "doing"
            else -> "overdue"
        }
    }

    /** 卡片倒计时: 开始前“剩 X” / 进行中“剩 X” / 逾期“已逾期 X” */
    fun lifeText(t: Todo, nowMs: Long = System.currentTimeMillis()): String {
        if (t.isDone || t.dueAt == null) return ""
        val due = t.dueAt
        val end = endAt(t) ?: due
        return when {
            nowMs < due -> "剩 " + cnDur(due - nowMs)
            nowMs < end -> "剩 " + cnDur(end - nowMs)
            else -> "已逾期 " + cnDur(nowMs - end)
        }
    }

    private fun cnDur(ms: Long): String {
        val min = maxOf(1, Math.round(Math.abs(ms) / 60000.0))
        return when {
            min < 60 -> "$min 分钟"
            min < 1440 -> {
                val h = min / 60.0
                if (h % 1.0 == 0.0) "${h.toInt()} 小时" else "%.1f".format(h) + " 小时"
            }
            else -> "%.1f".format(min / 1440.0) + " 天"
        }
    }

    fun countdown(t: Todo, nowMs: Long = System.currentTimeMillis()): String {
        val ts = t.dueAt ?: return ""
        val diff = ts - nowMs
        if (diff <= 0) {
            val over = Math.round(-diff / 60000.0)
            return if (over < 60) "已逾期 $over 分钟" else "已逾期 ${"%.1f".format(over / 60.0)} 小时"
        }
        val min = Math.round(diff / 60000.0)
        return when {
            min < 60 -> "剩 $min 分钟"
            min < 1440 -> "剩 ${if (min < 600) min / 60 else "%.1f".format(min / 60.0)} 小时"
            else -> "剩 ${"%.1f".format(min / 1440.0)} 天"
        }
    }

    fun duration(min: Int?): String {
        if (min == null) return ""
        return if (min < 60) "$min 分钟" else {
            val h = min / 60.0
            if (h % 1.0 == 0.0) "${h.toInt()} 小时" else "${min / 60} 小时 ${min % 60} 分钟"
        }
    }

    /** 日期分桶: overdue/today/tomorrow/week/later/none */
    fun bucket(ts: Long?, nowMs: Long = System.currentTimeMillis()): String {
        if (ts == null) return "none"
        val start = dayStartOf(nowMs)
        val day = ((dayStartOf(ts) - start) / 86400000L).toInt()
        return when {
            day < 0 -> "overdue"
            day == 0 -> "today"
            day == 1 -> "tomorrow"
            day < 7 -> "week"
            else -> "later"
        }
    }

    fun bucketLabel(b: String): String = when (b) {
        "overdue" -> "⏰ 已逾期"; "today" -> "🗓 今天"; "tomorrow" -> "🌅 明天"
        "week" -> "📅 7 天内"; "later" -> "📆 更晚"; else -> "🕘 未定时间"
    }

    private fun dayStartOf(ms: Long): Long {
        val cal = Calendar.getInstance().apply {
            timeInMillis = ms
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }
        return cal.timeInMillis
    }

    val impLabels = arrayOf("低", "中", "高")

    fun impText(t: Todo) = "⭐ " + impLabels.getOrElse(t.importance) { "中" }

    /** 重复标记: 每天 / 每周一 / 每月15日 */
    fun repeatCn(t: Todo): String {
        val due = t.dueAt ?: return ""
        val c = Calendar.getInstance().apply { timeInMillis = due }
        return when (t.repeat) {
            "daily" -> "每天"
            "weekly" -> {
                val w = c.get(Calendar.DAY_OF_WEEK)
                val cn = when (w) {
                    Calendar.MONDAY -> "一"; Calendar.TUESDAY -> "二"; Calendar.WEDNESDAY -> "三"
                    Calendar.THURSDAY -> "四"; Calendar.FRIDAY -> "五"; Calendar.SATURDAY -> "六"
                    else -> "日"
                }
                "每周$cn"
            }
            "monthly" -> "每月" + c.get(Calendar.DAY_OF_MONTH) + "日"
            else -> ""
        }
    }

    fun hmText(ms: Long): String = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(ms))
}
