package com.todoreminder.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.todoreminder.app.notify.Notifier
import com.todoreminder.app.notify.ReminderScheduler
import com.todoreminder.app.util.Fmt

/** 设置: 服务器地址 + 连接码 + 提醒权限引导 + 数据维护 */
class SettingsActivity : AppCompatActivity() {

    private lateinit var etUrl: EditText
    private lateinit var etToken: EditText
    private lateinit var tvState: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        val app = application as App

        etUrl = findViewById(R.id.etUrl)
        etToken = findViewById(R.id.etToken)
        tvState = findViewById(R.id.tvState)
        etUrl.setText(app.prefs.serverUrl)
        etToken.setText(app.prefs.token)
        findViewById<android.widget.ImageButton>(R.id.btnBack).setOnClickListener { finish() }

        val hint = getString(R.string.setting_hint) + " " +
            (app.prefs.configured().takeIf { it }?.let { "当前: " + app.prefs.serverUrl } ?: "尚未配置")
        tvState.text = hint
        refreshDiag()

        findViewById<Button>(R.id.btnSaveConn).setOnClickListener { saveConn() }
        findViewById<Button>(R.id.btnTest).setOnClickListener { testConn() }

        findViewById<Button>(R.id.btnNotifyPerm).setOnClickListener {
            if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
            } else ReminderScheduler.openNotificationSettings(this)
        }
        findViewById<Button>(R.id.btnExactAlarm).setOnClickListener {
            ReminderScheduler.openExactAlarmSettings(this)
        }
        findViewById<Button>(R.id.btnBattery).setOnClickListener {
            try {
                startActivity(
                    android.content.Intent(
                        android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        android.net.Uri.parse("package:" + packageName),
                    ).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            } catch (_: Exception) { toast("系统未提供该入口, 请到系统设置→应用→本应用→电池 中允许") }
        }
        findViewById<Button>(R.id.btnTestNotify).setOnClickListener {
            if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                toast("通知权限未允许 — 先点上方「允许通知」再测试")
                ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
                return@setOnClickListener
            }
            Notifier.show(
                this, 9001, "待办提醒 · 测试通知",
                "通知功能正常 ✓\n到点/提前提醒会像这样通知你(需允许通知与精确闹钟)",
            )
            toast("已发送测试通知 — 若没看到: ①通知权限 ②系统勿扰/省电限制")
        }
        findViewById<Button>(R.id.btnTestAlarm).setOnClickListener {
            if (Build.VERSION.SDK_INT >= 31 && !ReminderScheduler.canScheduleExact(this)) {
                toast("尚未允许精确闹钟 — 提醒可能延迟; 建议先点「允许精确闹钟」")
            }
            val fire = System.currentTimeMillis() + 8_000
            // 直接安排一条 8 秒后的真实闹钟验证提醒
            val app2 = application as App
            ReminderScheduler.rescheduleAll(
                this,
                app2.store.all() + com.todoreminder.app.data.Todo.fresh().copy(
                    id = "test-alarm-1", title = "测试闹钟(8秒后)", dueAt = fire,
                    remindBeforeMin = 0, updatedAt = System.currentTimeMillis(),
                ),
            )
            toast(if (ReminderScheduler.canScheduleExact(this)) "已安排 8 秒后测试闹钟 — 请锁屏等待横幅通知"
                else "已安排测试闹钟(未授权精确 → 约 1 分钟内送达)")
            refreshDiag()
        }

        val v = try { packageManager.getPackageInfo(packageName, 0).versionName } catch (_: Exception) { "?" }
        findViewById<TextView>(R.id.tvAbout).text = "待办提醒 v$v\n安卓端数据通过你电脑上的「待办提醒 · Windows」同步(需在同一网络或 Tailscale)。"

        // ---------- 一键更新: 从电脑端服务器拉取最新 APK 并安装 ----------
        val tvUpdate = findViewById<TextView>(R.id.tvUpdateState)
        tvUpdate.text = "当前版本 v$v · 需先在「连接电脑端」填好服务器地址与连接码"
        findViewById<Button>(R.id.btnUpdate).setOnClickListener {
            if (!app.prefs.configured()) { toast("请先填写服务器地址与连接码"); return@setOnClickListener }
            tvUpdate.text = "正在检查电脑端…"
            app.sync.fetchUpdateInfo { info, err ->
                runOnUiThread {
                    if (err != null) {
                        tvUpdate.text = "❌ 检查失败: ${err.message}\n请确认手机与电脑在同一网络(或两端 Tailscale 已开)。"
                        return@runOnUiThread
                    }
                    val latest = info?.optJSONObject("latest") ?: run {
                        tvUpdate.text = "电脑端暂无发布版本(构建后放入下载目录即可一键更新)"; return@runOnUiThread
                    }
                    val latestVer = latest.optString("version")
                    if (!verLess(v, latestVer)) {
                        tvUpdate.text = "✅ 已是最新(v$v) — 电脑端提供 $latestVer"
                        return@runOnUiThread
                    }
                    tvUpdate.text = "发现新版 v$latestVer, 正在下载…"
                    val base = app.prefs.serverUrl
                    val url = if (latest.optString("url").startsWith("http")) latest.optString("url") else base + latest.optString("url")
                    val dest = java.io.File(cacheDir, "todo-reminder-update.apk")
                    app.sync.downloadApk(url, dest) { ok, msg ->
                        runOnUiThread {
                            if (!ok) { tvUpdate.text = "❌ 下载失败: $msg"; return@runOnUiThread }
                            tvUpdate.text = "下载完成(${dest.length() / 1048576} MB), 正在安装…"
                            installApk(dest)
                        }
                    }
                }
            }
        }
    }

    private fun verLess(cur: String, other: String): Boolean {
        fun parse(s: String): List<Int> = s.trim().split('.', '-').mapNotNull { it.toIntOrNull() }
        val a = parse(cur); val b = parse(other)
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }; val y = b.getOrElse(i) { 0 }
            if (x != y) return x < y
        }
        return false
    }

    private fun installApk(file: java.io.File) {
        try {
            val uri = androidx.core.content.FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
            val i = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(i)
            toast("已调起安装界面 — 若未弹出, 请到系统设置允许本应用「安装未知应用」")
        } catch (e: Exception) {
            toast("无法调起安装: ${e.message}")
            ReminderScheduler.openAppSettings(this)
        }
    }

    /** 提醒诊断: 直接显示三个“会让通知失效”的开关状态, 避免测试静默失败 */
    private fun refreshDiag() {
        val sdk = Build.VERSION.SDK_INT
        val notifOk = sdk < 33 ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        val exactOk = ReminderScheduler.canScheduleExact(this)
        val pm = getSystemService(android.os.PowerManager::class.java)
        val batteryOk = pm?.isIgnoringBatteryOptimizations(packageName) == true
        val mark = { ok: Boolean -> if (ok) "✅ 已允许" else "⚠️ 未允许" }
        tvState.text = tvState.text?.takeIf { it.contains("提醒诊断") } ?: tvState.text
        tvState.text = "提醒诊断:\n• 通知权限: ${mark(notifOk)}\n• 精确闹钟: ${mark(exactOk)}\n• 电池优化: ${mark(batteryOk)}" +
            "\n任一为“未允许”都可能让提醒不响或延迟 → 点下方对应按钮允许后重测"
    }

    private fun saveConn() {
        val app = application as App
        app.prefs.serverUrl = etUrl.text.toString().trim().trimEnd('/')
        app.prefs.token = etToken.text.toString().trim()
        toast("已保存连接配置")
        testConn()
    }

    private fun testConn() {
        val app = application as App
        if (!app.prefs.configured()) { toast("请先填写服务器地址"); return }
        tvState.text = "测试中…"
        app.sync.syncAsync { err ->
            runOnUiThread {
                if (err == null) {
                    tvState.text = "✅ 连接成功 · 数据 ${app.store.active().size} 条(上次同步 ${Fmt.hmText(app.prefs.lastSyncedAt)})"
                    toast("同步成功")
                } else if (err is com.todoreminder.app.data.UnauthorizedException) {
                    tvState.text = "❌ 连接码错误(401)"
                } else {
                    tvState.text = "❌ 无法连接: ${err.message}"
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refreshDiag() // 从系统设置返回后即时刷新状态
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 100) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) toast("已允许通知 — 现在可点「测试通知」")
            else toast("未允许通知 — 提醒将无法弹出(可在系统设置中补开)")
            refreshDiag()
        }
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
}
