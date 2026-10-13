package com.todoreminder.app.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.todoreminder.app.App
import com.todoreminder.app.data.Period
import com.todoreminder.app.data.Todo
import com.todoreminder.app.util.Fmt

/**
 * 到点广播: 收到后回到本地仓库校验“事件是否仍然成立”, 避免修改/删除后的幽灵闹钟。
 * 待办事件: remind(提前提醒) / start(开始→进行中) / end(结束→逾期)。
 * 时段事件: remind(开始前提醒) / start(已进入时段)。
 */
class TodoAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.action) {
            ReminderScheduler.ACTION_FIRE -> fireTodo(ctx, intent)
            ReminderScheduler.ACTION_PERIOD_FIRE -> firePeriod(ctx, intent)
        }
    }

    // ---------- 待办 ----------
    private fun fireTodo(ctx: Context, intent: Intent) {
        val todoId = intent.getStringExtra("todoId") ?: return
        val kind = intent.getStringExtra("kind") ?: ReminderScheduler.EV_REMIND
        val app = ctx.applicationContext as App
        val t = app.store.get(todoId) ?: return
        if (t.deleted || t.isDone || t.dueAt == null) return
        if (t.fuzzy) return // 模糊事项: 到点/逾期都不弹通知

        val now = System.currentTimeMillis()
        val due = t.dueAt
        val dur = (t.durationMin ?: 0).coerceAtLeast(0)
        val end = due + dur * 60_000L

        val title: String = when (kind) {
            ReminderScheduler.EV_REMIND -> {
                val fireAt = due - t.remindBeforeMin * 60_000L
                if (!(now >= fireAt && now < due)) return // 旧闹钟/数据已改
                "⏰ 待办提醒: ${t.title}"
            }
            ReminderScheduler.EV_START -> {
                if (now < due - 60_000L) return
                if (dur > 0 && now >= end) return // 结束已过, 不补“开始”
                if (dur > 0) "▶ 进行中: ${t.title}" else "⏰ 到时间了: ${t.title}"
            }
            ReminderScheduler.EV_END -> {
                if (dur <= 0 || now < end - 60_000L) return
                "⚠️ 已逾期: ${t.title}"
            }
            else -> return
        }

        val parts = mutableListOf<String>()
        parts += "🕒 ${Fmt.dueText(t, now)}"
        if (dur > 0) parts += "⏱ 需要 ${Fmt.duration(dur)}"
        if (t.location.isNotBlank()) parts += "📍 ${t.location}"
        if (t.materials.isNotEmpty()) parts += "🧰 材料: " + t.materials.joinToString("、")
        if (!t.independent) parts += "🔗 依赖他人/前置"
        val body = parts.joinToString(" · ").ifBlank { t.notes.ifBlank { "到时间了!" } }
        Notifier.show(ctx, ReminderScheduler.reqFor(t.id, kind), title, body.take(400))
    }

    // ---------- 时段(多节点: 每段独立事件; 跨午夜收尾段 ownOff=1 响在次日) ----------
    private fun firePeriod(ctx: Context, intent: Intent) {
        val pid = intent.getStringExtra("periodId") ?: return
        val kind = intent.getStringExtra("kind") ?: ReminderScheduler.EV_REMIND
        val segS = intent.getIntExtra("segS", -1)
        val segE = intent.getIntExtra("segE", -1)
        val ownOff = intent.getIntExtra("ownOff", 0)
        val segKey = intent.getIntExtra("segKey", 0)
        if (segS < 0 || segE <= segS) return
        val app = ctx.applicationContext as App
        val p = app.periodStore.all().firstOrNull { it.id == pid && !it.deleted } ?: return

        val now = System.currentTimeMillis()
        val dayStart = java.util.Calendar.getInstance().apply {
            timeInMillis = now
            set(java.util.Calendar.HOUR_OF_DAY, 0); set(java.util.Calendar.MINUTE, 0)
            set(java.util.Calendar.SECOND, 0); set(java.util.Calendar.MILLISECOND, 0)
        }.timeInMillis
        // 归属日校验: 普通段归属今天; 次日凌晨收尾段归属“昨天开始的那次会话”
        val ownerDay = dayStart - ownOff * 86_400_000L
        val ownerCal = java.util.Calendar.getInstance().apply { timeInMillis = ownerDay }
        if (!com.todoreminder.app.data.periodActiveOnDay(p, ownerCal)) return

        val startAt = dayStart + segS * 60_000L   // segS 相对闹钟响起的那一天
        val endAt = dayStart + segE * 60_000L

        val title: String
        val bodyExtra: String
        when (kind) {
            ReminderScheduler.EV_REMIND -> {
                val fireAt = startAt - p.remindBeforeMin * 60_000L
                if (!(now >= fireAt - 60_000L && now < startAt)) return // 旧闹钟/数据已改
                val leftMin = Math.ceil((startAt - now) / 60000.0).toInt().coerceAtLeast(1)
                title = "⏳ 时段提醒: ${p.name}"
                bodyExtra = if (leftMin <= 1) "马上开始!" else "还有 $leftMin 分钟开始"
            }
            ReminderScheduler.EV_START -> {
                if (!(now >= startAt - 60_000L && now < endAt)) return
                title = "⏳ 已进入时段: ${p.name}"
                bodyExtra = "本次到 ${fmtMin(segE)}"
            }
            else -> return
        }
        val parts = mutableListOf(bodyExtra)
        parts += "🕒 ${fmtMin(segS)}–${fmtMin(segE)}"
        if (p.env.isNotBlank()) parts += "🌿 ${p.env}"
        parts += "优先度: " + (listOf("低", "中", "高").getOrElse(p.priority) { "中" })
        Notifier.show(
            ctx, ReminderScheduler.reqForPeriod(p.id, kind, segKey),
            title, parts.joinToString(" · ").take(300),
        )
    }

    private fun fmtMin(min: Int?): String {
        if (min == null) return "--:--"
        return String.format("%02d:%02d", min / 60, min % 60)
    }
}

/** 开机 / 应用升级后重排提醒(闹钟在重启后会丢失) */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val a = intent.action
        if (a != Intent.ACTION_BOOT_COMPLETED && a != Intent.ACTION_LOCKED_BOOT_COMPLETED &&
            a != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val app = ctx.applicationContext as App
        Notifier.ensureChannel(ctx)
        ReminderScheduler.rescheduleAll(ctx, app.store.all())
        ReminderScheduler.reschedulePeriods(ctx, app.periodStore.all())
    }
}
