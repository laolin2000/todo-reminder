package com.todoreminder.web.notify

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import com.todoreminder.web.data.Todo

/**
 * 提醒调度 — AlarmManager + BroadcastReceiver(参考 beeCount 式闹钟提醒)。
 * 每个待办最多三类闹钟: 提前提醒(EV_REMIND, remindBeforeMin>0)、
 * 开始(EV_START → 自动进入“进行中”/到时间了)、结束(EV_END, 有时长 → 逾期提示)。
 * 每个时段: 开始前提醒(EV_REMIND) + 开始通知(EV_START, 进入时段)。
 * 先取消再重设 — 修改/删除后旧时刻的闹钟不会残留。
 */
object ReminderScheduler {
    const val ACTION_FIRE = "com.todoreminder.web.ACTION_FIRE"
    const val ACTION_PERIOD_FIRE = "com.todoreminder.web.ACTION_PERIOD_FIRE"

    const val EV_REMIND = "remind"
    const val EV_START = "start"
    const val EV_END = "end"

    private const val MAX_AHEAD_MS = 180L * 24 * 3600 * 1000 // 最远提前 180 天
    private const val MAX_COUNT = 600
    private val KINDS = listOf(EV_REMIND, EV_START, EV_END)

    private fun salt(kind: String): Int = when (kind) {
        EV_REMIND -> 0x2e11
        EV_END -> 0x5d33
        else -> 0x7f55
    }

    /** 同一记录不同事件的稳定请求码 / 通知 id(正数, 相互不冲突) */
    fun reqFor(todoId: String, kind: String): Int {
        val base = (todoId.hashCode() and 0x7fffffff) % 1_000_000_000
        return (base xor salt(kind)) and 0x3fffffff
    }

    fun reqForPeriod(periodId: String, kind: String, segKey: Int = 0): Int {
        val base = (("p:" + periodId + "|" + kind + "|" + segKey).hashCode() and 0x7fffffff) % 1_000_000_000
        return base and 0x3fffffff
    }

    fun canScheduleExact(ctx: Context): Boolean {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        return Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()
    }

    /** 是否已加入“忽略电池优化”白名单 —— 未加入时 Doze/厂商省电会延迟闹钟甚至清理后台 */
    fun isIgnoringBatteryOptimizations(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < 23) return true
        return try {
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            pm.isIgnoringBatteryOptimizations(ctx.packageName)
        } catch (_: Exception) { false }
    }

    /** 引导把本应用加入电池优化白名单(系统请求页 → 白名单列表页 → 应用详情 逐级兜底) */
    fun openBatteryOptimizationSettings(ctx: Context) {
        if (Build.VERSION.SDK_INT >= 23) {
            try {
                val i = Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    android.net.Uri.parse("package:" + ctx.packageName),
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.startActivity(i)
                return
            } catch (_: Exception) { /* 部分 ROM 无此页 */ }
            try {
                val i = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.startActivity(i)
                return
            } catch (_: Exception) { /* 无列表页 */ }
        }
        openAppSettings(ctx)
    }

    fun openExactAlarmSettings(ctx: Context) {
        if (Build.VERSION.SDK_INT >= 31) {
            try {
                val i = Intent(
                    Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                    android.net.Uri.parse("package:" + ctx.packageName),
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.startActivity(i)
                return
            } catch (_: Exception) { /* 部分 ROM 无此页 */ }
        }
        openAppSettings(ctx)
    }

    fun openAppSettings(ctx: Context) {
        try {
            val i = Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                android.net.Uri.parse("package:" + ctx.packageName),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ctx.startActivity(i)
        } catch (_: Exception) { /* ignore */ }
    }

    fun openNotificationSettings(ctx: Context) {
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                val i = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.startActivity(i)
            } catch (_: Exception) { openAppSettings(ctx) }
        } else openAppSettings(ctx)
    }

    // ---------- 待办闹钟 ----------

    private fun todoAlarmIntent(ctx: Context, t: Todo, req: Int, kind: String): PendingIntent {
        val i = Intent(ctx, TodoAlarmReceiver::class.java).setAction(ACTION_FIRE)
        i.putExtra("todoId", t.id)
        i.putExtra("kind", kind)
        return PendingIntent.getBroadcast(ctx, req, i,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /**
     * 全量重排待办闹钟: 为“未来且未完成”的每条待办安排 提醒/开始/结束。
     * 幂等 — 启动 / 同步 / 开机广播 / 回前台后调用即可。
     *
     * 不做“先全量取消”: (1) 同一条待办同一事件用同一 requestCode, set 会覆盖旧闹钟;
     * (2) 已删除/完成/改期/模糊的旧闹钟即使残留, TodoAlarmReceiver 有数据+时间窗口
     * 双重校验, 到点会静默忽略 —— 取消只是省一次空响, 却让每次保存付出数百次系统
     * IPC 的代价(手机端“操作后卡半秒”的主因), 故移除。
     */
    fun rescheduleAll(ctx: Context, todos: List<Todo>) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val exact = canScheduleExact(ctx)
        val now = System.currentTimeMillis()
        var count = 0
        for (t in todos) {
            if (t.deleted || t.isDone || t.dueAt == null) continue
            val due = t.dueAt
            val dur = (t.durationMin ?: 0).coerceAtLeast(0)
            val plans = ArrayList<Pair<Long, String>>()
            if (t.remindBeforeMin > 0) plans += (due - t.remindBeforeMin * 60_000L) to EV_REMIND
            plans += due to EV_START
            if (dur > 0) plans += (due + dur * 60_000L) to EV_END
            for ((at, kind) in plans) {
                if (at <= now || at > now + MAX_AHEAD_MS) continue
                val pi = todoAlarmIntent(ctx, t, reqFor(t.id, kind), kind)
                fire(ctx, am, exact, at, pi)
                if (++count >= MAX_COUNT) return
            }
            // 重复触发(每天/每周/每月): 本期已过且未完成时, 仍把下一周期的提醒排上 → 持续重复触发;
            // 勾选完成时由 MainActivity 把 dueAt 滚到下一周期, 走上面的普通分支即可。
            if (t.repeat != "none" && due <= now) {
                val nxt = com.todoreminder.web.data.nextOccurrenceMs(t, now) ?: continue
                if (nxt <= now || nxt > now + MAX_AHEAD_MS) continue
                val nplans = ArrayList<Pair<Long, String>>()
                if (t.remindBeforeMin > 0) nplans += (nxt - t.remindBeforeMin * 60_000L) to EV_REMIND
                nplans += nxt to EV_START
                if (dur > 0) nplans += (nxt + dur * 60_000L) to EV_END
                for ((at, kind) in nplans) {
                    if (at <= now || at > now + MAX_AHEAD_MS) continue
                    fire(ctx, am, exact, at, todoAlarmIntent(ctx, t, reqFor(t.id, kind), kind))
                    if (++count >= MAX_COUNT) return
                }
            }
        }
    }

    // ---------- 时段闹钟(多节点: 每段独立闹钟; 跨午夜拆成“当天开始段 + 次日凌晨收尾段”) ----------

    private fun periodAlarmIntent(
        ctx: Context, pid: String, kind: String, segKey: Int,
        absS: Long, absE: Long, segS: Int, segE: Int,
    ): PendingIntent {
        val i = Intent(ctx, TodoAlarmReceiver::class.java).setAction(ACTION_PERIOD_FIRE)
        i.putExtra("periodId", pid)
        i.putExtra("kind", kind)
        i.putExtra("segKey", segKey)
        i.putExtra("segS", segS)      // 仅用于通知文案(当天分钟)
        i.putExtra("segE", segE)
        i.putExtra("absS", absS)      // 本次事件开始的绝对时刻(校验用)
        i.putExtra("absE", absE)      // 本次事件结束的绝对时刻(校验用)
        return PendingIntent.getBroadcast(ctx, reqForPeriod(pid, kind, segKey), i,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /**
     * 时段提醒 — 按“节点”调度(不是单一 startMin/endMin):
     * 每个命中今天的时段, 为每个节点安排 提前提醒(EV_REMIND) + 开始(EV_START);
     * 节点跨午夜(endMin < startMin)时拆成 当天段 + 次日收尾段, 次日段仍算今天会话(闹钟响在次日)。
     * 全部一次性闹钟, 每天 0 点后的首次调用会为当天安排。
     * 不做“先全量取消”: 同(时段,事件,段)同一 requestCode 直接覆盖; 改期/删除后的
     * 残留闹钟由 TodoAlarmReceiver 的归属日+时间窗口校验静默忽略(参见 rescheduleAll 注释)。
     */
    fun reschedulePeriods(ctx: Context, periods: List<com.todoreminder.web.data.Period>) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val exact = canScheduleExact(ctx)
        val nowMs = System.currentTimeMillis()
        val dayStart = java.util.Calendar.getInstance().apply {
            timeInMillis = nowMs
            set(java.util.Calendar.HOUR_OF_DAY, 0); set(java.util.Calendar.MINUTE, 0)
            set(java.util.Calendar.SECOND, 0); set(java.util.Calendar.MILLISECOND, 0)
        }.timeInMillis
        val cal0 = java.util.Calendar.getInstance().apply { timeInMillis = dayStart }
        var count = 0
        for (p in periods) {
            if (p.deleted || p.nodes.isEmpty()) continue
            if (!com.todoreminder.web.data.periodActiveOnDay(p, cal0)) continue // 今天不命中 → 不排
            var segKey = 0
            for ((ns, ne) in p.nodes) {
                if (ne == ns) continue
                val segs: List<Triple<Int, Int, Int>> =
                    if (ne < ns) listOf(Triple(ns, 1440, 0), Triple(0, ne, 1))
                    else listOf(Triple(ns, ne, 0))
                for ((s, e, off) in segs) {
                    segKey++
                    val evDay = dayStart + off * 86_400_000L
                    val absS = evDay + s * 60_000L
                    val absE = evDay + e * 60_000L
                    if (absS <= nowMs || absS > nowMs + MAX_AHEAD_MS) continue
                    val plans = ArrayList<Pair<Long, String>>()
                    if (p.remindBeforeMin > 0) plans += (absS - p.remindBeforeMin * 60_000L) to EV_REMIND
                    plans += absS to EV_START
                    for ((at, kind) in plans) {
                        if (at <= nowMs) continue
                        val pi = periodAlarmIntent(ctx, p.id, kind, segKey, absS, absE, s, e)
                        fire(ctx, am, exact, at, pi)
                        if (++count >= MAX_COUNT) return
                    }
                }
            }
        }
    }

    private fun fire(ctx: Context, am: AlarmManager, exact: Boolean, at: Long, pi: PendingIntent) {
        // 有“精确闹钟”授权 → 准点; 否则宽窗近似(≤2 分钟; 近处闹钟用更小的窗, 避免“测试迟迟不来”)
        try {
            if (exact) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
            } else {
                val slack = Math.max(60_000L, Math.min(2 * 60_000L, at - System.currentTimeMillis() + 5_000L))
                am.setWindow(AlarmManager.RTC_WAKEUP, at, slack, pi)
            }
        } catch (_: Exception) {
            try { am.setWindow(AlarmManager.RTC_WAKEUP, at, 2 * 60_000L, pi) } catch (_2: Exception) { /* 忽略 */ }
        }
    }
}
