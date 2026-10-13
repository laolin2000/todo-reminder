package com.todoreminder.web.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.todoreminder.web.MainActivity
import com.todoreminder.web.R

/** 系统通知渠道与发送(到点/提前提醒) */
object Notifier {
    const val CHANNEL_ID = "todo_reminders"
    private const val NOTIFY_TAG = "todo"

    fun ensureChannel(ctx: Context) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            val ch = NotificationChannel(
                CHANNEL_ID,
                "待办提醒",
                NotificationManager.IMPORTANCE_HIGH, // 响铃+横幅
            ).apply {
                description = "待办事项到点/提前提醒"
                enableVibration(true)
            }
            nm.createNotificationChannel(ch)
        }
    }

    /**
     * 发送一条提醒。
     * @param notifId 稳定 id(由待办 id 派生)
     * @param title 通知标题
     * @param body 通知正文(时间/地点/材料等)
     */
    fun show(ctx: Context, notifId: Int, title: String, body: String) {
        ensureChannel(ctx)
        val contentIntent = PendingIntent.getActivity(
            ctx, 0,
            Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_todo)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(contentIntent)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        try {
            NotificationManagerCompat.from(ctx).notify(NOTIFY_TAG, notifId, builder.build())
        } catch (e: SecurityException) {
            // Android 13+ 未授予 POST_NOTIFICATIONS — 忽略(系统会收进通知中心外)
        }
    }
}
