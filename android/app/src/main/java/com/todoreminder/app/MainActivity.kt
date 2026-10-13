package com.todoreminder.app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ImageButton
import android.widget.PopupMenu
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import com.google.android.material.floatingactionbutton.FloatingActionButton
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import com.todoreminder.app.data.Period
import com.todoreminder.app.data.Todo
import com.todoreminder.app.data.fmtMin
import com.todoreminder.app.data.freqLabel
import com.todoreminder.app.data.periodActiveOnDay
import com.todoreminder.app.notify.Notifier
import com.todoreminder.app.notify.ReminderScheduler
import com.todoreminder.app.ui.PeriodAdapter
import com.todoreminder.app.ui.TodoAdapter
import com.todoreminder.app.util.Fmt
import com.todoreminder.app.util.Palette
import org.json.JSONArray

/** 主界面: 列表/时段/轨迹 三视图 + 同步 */
class MainActivity : AppCompatActivity(), TodoAdapter.Listener {

    private val app: App get() = application as App
    private lateinit var adapter: TodoAdapter
    private lateinit var rv: RecyclerView
    private lateinit var rvPeriods: RecyclerView
    private lateinit var traceScroll: View
    private lateinit var traceBox: android.widget.LinearLayout
    private lateinit var empty: TextView
    private lateinit var statusDot: TextView
    private lateinit var tvLastSync: TextView
    private lateinit var searchEt: EditText
    private lateinit var chipsStatus: ChipGroup
    private lateinit var chipsMode: ChipGroup
    private lateinit var sortText: TextView
    private lateinit var groupText: TextView
    private lateinit var tvSyncStatus: TextView
    private lateinit var scrollStatus: View
    private lateinit var rowToolbar: View
    private lateinit var rowNowPeriod: View
    private lateinit var tvNowPeriod: TextView
    private lateinit var btnAi: TextView
    private var aiBusy = false

    // 视图状态
    private var mode = "list"         // list / periods / trace
    private var tab = "all"            // all/today/todo/done/overdue
    private var sortKey = "dueAt"      // dueAt/importance/durationMin/location/createdAt
    private var sortAsc = true
    private var groupIdx = 1           // 0 不分组 / 1 日期 / 2 地点 / 3 重要 / 4 独立性 / 5 状态
    private var impSel = mutableSetOf<Int>()
    private var indepSel = 0           // 0 全部 / 1 独立 / 2 依赖
    private val collapsed = mutableSetOf<String>()
    private var syncing = false
    private var firstRunChecked = false
    private var exactHintShown = false

    private val ui = Handler(Looper.getMainLooper())
    private val syncTick = object : Runnable {
        override fun run() {
            maybeSync()
            ui.postDelayed(this, 30_000)
        }
    }

    private val editLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        if (res.resultCode == Activity.RESULT_OK) {
            val json = res.data?.getStringExtra("todo") ?: return@registerForActivityResult
            try {
                app.store.upsert(listOf(Todo.fromJson(org.json.JSONObject(json))))
                pushChanges()
            } catch (e: Exception) { toast("保存失败") }
        }
        refresh()
    }

    private val periodLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        if (res.resultCode == Activity.RESULT_OK) {
            val json = res.data?.getStringExtra("period") ?: return@registerForActivityResult
            try {
                app.periodStore.upsert(listOf(Period.fromJson(org.json.JSONObject(json))))
                pushChanges()
            } catch (e: Exception) { toast("保存失败") }
        }
        refresh()
    }

    private val aiPickLauncher = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) aiCreateFromImage(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        bindViews()
        adapter = TodoAdapter(this)
        rv.layoutManager = LinearLayoutManager(this)
        rv.adapter = adapter
        rvPeriods.layoutManager = LinearLayoutManager(this)

        findViewById<ImageButton>(R.id.btnRefresh).setOnClickListener { pushChanges(forceSync = true) }
        findViewById<ImageButton>(R.id.btnSettings).setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
        btnAi.setOnClickListener {
            if (!app.prefs.configured()) { toast("请先在设置里填服务器地址与连接码"); return@setOnClickListener }
            if (aiBusy) return@setOnClickListener
            aiPickLauncher.launch("image/*")
        }
        findViewById<FloatingActionButton>(R.id.fabAdd).setOnClickListener {
            when (mode) {
                "periods" -> openPeriodEdit(null)
                "trace" -> { /* 轨迹页不新建 */ }
                else -> openEdit(null)
            }
        }
        setupModeChips()
        setupStatusChips()
        setupToolbarRows()
        applyModeVis()
        refresh()
        Notifier.ensureChannel(this)
        ensureNotifyPermissions()
    }

    private val notifPermLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    /** Android 13+ 通知运行时权限 + Android 12+ 精确闹钟引导(一次性, 可拒绝 → 自动宽窗降级) */
    private fun ensureNotifyPermissions() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (Build.VERSION.SDK_INT >= 31 && !ReminderScheduler.canScheduleExact(this) && !exactHintShown) {
            exactHintShown = true
            AlertDialog.Builder(this)
                .setTitle("到点提醒更可靠?")
                .setMessage("允许「闹钟和提醒」后, 提醒会准点到达; 不允许也能收到, 但可能延迟几分钟。\n需要时可在 设置 → 提醒权限 里随时开启。")
                .setPositiveButton("去授权") { _, _ -> ReminderScheduler.openExactAlarmSettings(this) }
                .setNegativeButton("暂不", null)
                .show()
        }
    }

    private val uiTick = object : Runnable {
        override fun run() {
            // 派生状态/倒计时每分钟级自动刷新(到点自动变“进行中”, 结束自动变“已逾期”)
            if (mode == "list" || mode == "trace") refresh()
            ui.postDelayed(this, 20_000)
        }
    }

    override fun onResume() {
        super.onResume()
        maybeSync()
        ui.removeCallbacks(syncTick)
        ui.postDelayed(syncTick, 30_000)
        ui.removeCallbacks(uiTick)
        ui.postDelayed(uiTick, 20_000)
        // 回到前台即重排闹钟(离线编辑/同步失败也生效)
        ReminderScheduler.rescheduleAll(this, app.store.all())
        ReminderScheduler.reschedulePeriods(this, app.periodStore.all())
    }

    override fun onPause() {
        super.onPause()
        ui.removeCallbacks(syncTick)
        ui.removeCallbacks(uiTick)
    }

    private fun bindViews() {
        rv = findViewById(R.id.rvList)
        rvPeriods = findViewById(R.id.rvPeriods)
        traceScroll = findViewById(R.id.traceScroll)
        traceBox = findViewById(R.id.traceBox)
        empty = findViewById(R.id.tvEmpty)
        statusDot = findViewById(R.id.tvStatusDot)
        tvSyncStatus = findViewById(R.id.tvSyncStatus)
        tvLastSync = findViewById(R.id.tvLastSync)
        searchEt = findViewById(R.id.etSearch)
        chipsStatus = findViewById(R.id.chipStatus)
        chipsMode = findViewById(R.id.chipsMode)
        sortText = findViewById(R.id.tvSort)
        groupText = findViewById(R.id.tvGroup)
        scrollStatus = findViewById(R.id.scrollStatus)
        rowToolbar = findViewById(R.id.rowToolbar)
        rowNowPeriod = findViewById(R.id.rowNowPeriod)
        tvNowPeriod = findViewById(R.id.tvNowPeriod)
        btnAi = findViewById(R.id.btnAi)
        searchEt.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) { if (mode == "list") refresh() }
        })
    }

    private fun setupModeChips() {
        chipsMode.removeAllViews()
        val defs = listOf("list" to "☰ 列表", "periods" to "⏳ 时段", "trace" to "⏱ 轨迹")
        for ((k, label) in defs) {
            val chip = Chip(this).apply {
                text = label
                isCheckable = true
                isChecked = k == mode
                setOnClickListener { setMode(k) }
            }
            chipsMode.addView(chip)
        }
    }

    private fun setMode(m: String) {
        mode = m
        for (i in 0 until chipsMode.childCount) {
            (chipsMode.getChildAt(i) as? Chip)?.isChecked = false
        }
        for (i in 0 until chipsMode.childCount) {
            val c = chipsMode.getChildAt(i) as? Chip ?: continue
            c.isChecked = (c.text ?: "").contains(if (m == "list") "列表" else if (m == "periods") "时段" else "轨迹")
        }
        applyModeVis()
        refresh()
    }

    private fun applyModeVis() {
        val listMode = mode == "list"
        rv.visibility = if (mode == "list") View.VISIBLE else View.GONE
        empty.visibility = View.GONE
        rvPeriods.visibility = if (mode == "periods") View.VISIBLE else View.GONE
        traceScroll.visibility = if (mode == "trace") View.VISIBLE else View.GONE
        scrollStatus.visibility = if (listMode) View.VISIBLE else View.GONE
        rowToolbar.visibility = if (listMode) View.VISIBLE else View.GONE
        if (listMode) refresh()
    }

    private fun openPeriodEdit(p: Period?) {
        val i = Intent(this, EditPeriodActivity::class.java)
        if (p != null) i.putExtra("period", Period.toJson(p).toString())
        periodLauncher.launch(i)
    }

    private fun setupStatusChips() {
        chipsStatus.removeAllViews()
        val defs = listOf(
            "all" to "全部", "today" to "今天", "todo" to "未完成",
            "done" to "已完成", "overdue" to "已逾期",
        )
        for ((k, label) in defs) {
            val chip = Chip(this).apply {
                text = label
                isCheckable = true
                isChecked = k == tab
                setOnClickListener {
                    tab = k
                    for (i in 0 until chipsStatus.childCount) {
                        (chipsStatus.getChildAt(i) as? Chip)?.isChecked = false
                    }
                    isChecked = true
                    refresh()
                }
            }
            chipsStatus.addView(chip)
        }
    }

    private fun setupToolbarRows() {
        sortText.text = sortLabel()
        sortText.setOnClickListener {
            val items = arrayOf("按时间", "重要程度(高→低)", "所需时间(长→短)", "按地点", "按创建时间(新→旧)")
            AlertDialog.Builder(this).setTitle("排序")
                .setSingleChoiceItems(items, when (sortKey) {
                    "dueAt" -> 0; "importance" -> 1; "durationMin" -> 2; "location" -> 3; else -> 4
                }) { d, w ->
                    sortKey = when (w) { 0 -> "dueAt"; 1 -> "importance"; 2 -> "durationMin"; 3 -> "location"; else -> "createdAt" }
                    sortAsc = when (sortKey) { "dueAt", "location" -> true; else -> false }
                    d.dismiss(); refresh()
                }.show()
        }
        groupText.text = groupLabel()
        groupText.setOnClickListener {
            AlertDialog.Builder(this).setTitle("分组")
                .setSingleChoiceItems(arrayOf("不分组", "按日期", "按地点", "按重要程度", "按独立性", "按状态"), groupIdx) { d, w ->
                    groupIdx = w; d.dismiss(); refresh()
                }.show()
        }
        findViewById<View>(R.id.btnFilter).setOnClickListener { showFilterDialog() }
    }

    private fun sortLabel(): String {
        val n = when (sortKey) {
            "dueAt" -> "时间"; "importance" -> "重要程度"; "durationMin" -> "所需时间"
            "location" -> "地点"; else -> "创建时间"
        }
        val arr = if (sortAsc) "↑" else "↓"
        return "$n $arr"
    }

    private fun groupLabel(): String = when (groupIdx) {
        0 -> "不分组"; 1 -> "按日期"; 2 -> "按地点"; 3 -> "按重要程度"; 4 -> "按独立性"; else -> "按状态"
    }

    private fun showFilterDialog() {
        val list = arrayOf("低", "中", "高")
        val checked = BooleanArray(3) { it in impSel }
        AlertDialog.Builder(this)
            .setTitle("筛选: 重要程度(多选)")
            .setMultiChoiceItems(list, checked) { _, i, c ->
                if (c) impSel.add(i) else impSel.remove(i)
            }
            .setPositiveButton("确定") { _, _ -> refresh() }
            .setNeutralButton("独立性") { d, _ ->
                d.dismiss()
                val opts = arrayOf("全部", "仅独立", "仅依赖")
                AlertDialog.Builder(this).setTitle("独立性")
                    .setSingleChoiceItems(opts, indepSel) { dd, w ->
                        indepSel = w; dd.dismiss(); refresh()
                    }.show()
            }
            .setNegativeButton("清除") { _, _ -> impSel.clear(); indepSel = 0; refresh() }
            .show()
    }

    private fun maybeSync() {
        if (!app.prefs.configured()) {
            setConn(false, "未配置服务器")
            if (!firstRunChecked) {
                firstRunChecked = true
                startActivity(Intent(this, SettingsActivity::class.java))
            }
            return
        }
        pushChanges(forceSync = false)
    }

    private fun pushChanges(forceSync: Boolean = false) {
        if (syncing) return
        syncing = true
        setConn(true, "同步中…")
        app.sync.syncAsync { err ->
            ui.post {
                syncing = false
                if (err == null) {
                    setConn(false, "已同步 " + Fmt.hmText(System.currentTimeMillis()))
                    refresh()
                } else if (err is com.todoreminder.app.data.UnauthorizedException) {
                    setConn(false, "连接码错误")
                    toast("连接码错误, 请在设置中更新")
                } else {
                    setConn(false, "离线(稍后自动重试)")
                }
                // 无论同步成败都按本地数据重排闹钟(离线新建也能按时提醒)
                ReminderScheduler.rescheduleAll(this@MainActivity, app.store.all())
                ReminderScheduler.reschedulePeriods(this@MainActivity, app.periodStore.all())
            }
        }
    }

    private fun setConn(syncing: Boolean, text: String) {
        statusDot.text = if (syncing) "●" else "●"
        statusDot.setTextColor(
            if (syncing) getColor(R.color.warn)
            else if (text.contains("已同步")) getColor(R.color.ok)
            else getColor(R.color.bad),
        )
        tvSyncStatus.text = text
    }

    // ---------- 列表组装 ----------
    private fun refresh() {
        renderNowPeriod()
        if (mode == "periods") { renderPeriods(); return }
        if (mode == "trace") { renderTrace(); return }
        val now = System.currentTimeMillis()
        var list = app.store.active()

        list = list.filter { t ->
            val l = Fmt.life(t, now)
            val done = l == "done"
            val bucket = Fmt.bucket(t.dueAt, now)
            when (tab) {
                "done" -> done
                "todo" -> !done
                "overdue" -> l == "overdue"
                "today" -> !done && bucket == "today" // 今天包括已超时未完成的(它们同时出现在“已逾期”)
                else -> true
            }
        }
        if (impSel.isNotEmpty()) list = list.filter { it.importance in impSel }
        when (indepSel) {
            1 -> list = list.filter { it.independent }
            2 -> list = list.filter { !it.independent }
        }
        val q = searchEt.text.toString().trim().lowercase()
        if (q.isNotEmpty()) list = list.filter { t ->
            (listOf(t.title, t.notes, t.location) + t.materials)
                .joinToString(" ").lowercase().contains(q)
        }

        // 排序
        val asc = sortAsc
        val comparator = Comparator<Todo> { a, b ->
            fun v(t: Todo): Comparable<*>? = when (sortKey) {
                "importance" -> t.importance
                "durationMin" -> t.durationMin
                "location" -> t.location.ifBlank { null }
                "createdAt" -> t.createdAt
                else -> t.dueAt
            }
            val va = v(a); val vb = v(b)
            val r = if (va == null && vb == null) 0
            else if (va == null) 1
            else if (vb == null) -1
            else when (va) {
                is Int -> (va - (vb as Int)) * if (asc) 1 else -1
                is Long -> java.lang.Long.compare(va, (vb as Long)) * if (asc) 1 else -1
                is String -> va.compareTo(vb as String, ignoreCase = true)
                else -> 0
            }
            if (r != 0) r else {
                val r2 = b.importance - a.importance
                if (r2 != 0) r2 else java.lang.Long.compare(a.createdAt, b.createdAt)
            }
        }
        list = list.sortedWith(comparator)

        // 分组
        val items = mutableListOf<Any>()
        if (groupIdx == 0) {
            items.addAll(list)
        } else {
            val groups = LinkedHashMap<String, MutableList<Todo>>()
            for (t in list) {
                val k = when (groupIdx) {
                    1 -> if (t.isDone) "done" else Fmt.bucket(t.dueAt, now)
                    2 -> t.location.trim().ifBlank { "∅" }
                    3 -> t.importance.toString()
                    4 -> if (t.independent) "1" else "0"
                    else -> Fmt.life(t, now)
                }
                groups.getOrPut(k) { mutableListOf() }.add(t)
            }
            val order = if (groupIdx == 1) listOf("overdue", "today", "tomorrow", "week", "later", "none", "done")
            else if (groupIdx == 3) listOf("2", "1", "0")
            else if (groupIdx == 4) listOf("1", "0")
            else if (groupIdx == 5) listOf("todo", "doing", "overdue", "done")
            else null
            val keys = groups.keys.toMutableList()
            if (order != null) keys.sortBy { order.indexOf(it).let { i -> if (i < 0) order.size else i } }
            if (groupIdx == 2) keys.sortWith(compareBy<String> { it == "∅" }.thenBy { it })
            for (k in keys) {
                val label = when (groupIdx) {
                    1 -> if (k == "done") "✅ 已完成" else Fmt.bucketLabel(k)
                    2 -> if (k == "∅") "📍 未填地点" else "📍 $k"
                    3 -> "⭐ ${Fmt.impLabels[k.toInt()]}"
                    4 -> if (k == "1") "🔗 独立事项" else "🔗 依赖他人/前置条件"
                    else -> when (k) { "todo" -> "待办"; "doing" -> "进行中"; "overdue" -> "已逾期"; else -> "已完成" }
                }
                val ck = "$groupIdx:$k"
                items.add("H|$ck|$label|${groups[k]!!.size}")
                if (!collapsed.contains(ck)) items.addAll(groups[k]!!)
            }
        }
        adapter.submit(items, now)
        val hasItems = items.isNotEmpty()
        empty.visibility = if (hasItems) View.GONE else View.VISIBLE
        rv.visibility = if (hasItems) View.VISIBLE else View.GONE
        updateChipCounts(now)
    }

    /** 主页面“当前时段”横幅: 正在进行的时段 + 剩余时间 + 下个时段; 点按切到轨迹视图 */
    private fun renderNowPeriod() {
        val cal = java.util.Calendar.getInstance()
        val today = app.periodStore.active().filter {
            com.todoreminder.app.data.periodActiveOnDay(it, cal)
        }
        val show = mode != "periods" && today.isNotEmpty()
        rowNowPeriod.visibility = if (show) View.VISIBLE else View.GONE
        if (!show) return
        val m = cal.get(java.util.Calendar.HOUR_OF_DAY) * 60 + cal.get(java.util.Calendar.MINUTE)
        // 把所有“今天生效”时段的全部节点段展开, 按开始时间排序(优先度高的同刻在前)
        val segs = ArrayList<Triple<Int, Int, Period>>()
        for (p in today) {
            for (seg in com.todoreminder.app.data.periodDaySegments(p)) {
                if (seg.second > seg.first) segs += Triple(seg.first, seg.second, p)
            }
        }
        segs.sortWith(compareBy<Triple<Int, Int, Period>> { it.first }.thenByDescending { it.third.priority })
        val curSeg = segs.firstOrNull { m >= it.first && m < it.second }
        val nxtSeg = segs.firstOrNull { it.first > m }
        // 双状态: 激活中 → 激活名; 未激活且有空闲名 → 空闲名
        val sb = StringBuilder()
        if (curSeg != null) {
            val p = curSeg.third
            sb.append("⏳ 当前: ").append(p.name).append(' ')
                .append(com.todoreminder.app.data.fmtMin(curSeg.first)).append('–')
                .append(com.todoreminder.app.data.fmtMin(curSeg.second))
                .append(" · 剩 ").append(Fmt.duration(curSeg.second - m))
        } else {
            val idleName = today.firstOrNull { it.idleName.isNotBlank() }?.idleName
            sb.append(if (idleName != null) "💤 空闲: $idleName" else "当前不在时段内")
        }
        if (nxtSeg != null) {
            sb.append(" · 下个: ").append(nxtSeg.third.name).append(' ')
                .append(com.todoreminder.app.data.fmtMin(nxtSeg.first))
        }
        tvNowPeriod.text = sb.toString()
        tvNowPeriod.setOnClickListener { setMode("trace") }
    }

    // ---------- 时段库视图 ----------
    private fun renderPeriods() {
        val list = app.periodStore.active()
            .sortedWith(compareByDescending<Period> { it.priority }.thenBy { it.startMin ?: 1440 })
        rvPeriods.adapter = PeriodAdapter(
            list,
            { openPeriodEdit(it) },
            { confirmDeletePeriod(it) },
        )
        if (list.isEmpty()) {
            rvPeriods.visibility = View.GONE
            empty.visibility = View.VISIBLE
            empty.text = "还没有时段\n点右下角 ＋ 新建(如: 上午专注 / 通勤)"
        } else {
            rvPeriods.visibility = View.VISIBLE
            empty.visibility = View.GONE
        }
    }

    private fun confirmDeletePeriod(p: Period) {
        AlertDialog.Builder(this)
            .setMessage("删除时段「${p.name}」? 颜色槽将释放, 挂入的待办回到未安排。")
            .setPositiveButton("删除") { _, _ ->
                app.periodStore.upsert(listOf(p.copyDeleted(app.prefs.clockSkew)))
                refresh(); pushChanges()
            }.setNegativeButton("取消", null).show()
    }

    // ---------- 轨迹视图(手机端: 今日瀑布流 · 与网页版一致) ----------
    // X 轴 0-24h: 每小时刻度线与标签; 事项按「开始时间 + 所需时长」覆盖色块(重复覆盖另起一行);
    // 今日生效时段 = 大面积半透明色带垫底(不参与拖动); 单击色块 = 详情/编辑, 长按 = 快速改时间, 按住横拖 = 改时间。
    private fun renderTrace() {
        traceBox.removeAllViews()
        try {
            renderTraceInner()
        } catch (e: Throwable) {
            // 兜底: 渲染异常也显示在页面上, 便于定位(不白屏)
            val d = resources.displayMetrics.density
            traceBox.addView(TextView(this).apply {
                text = "⚠️ 轨迹渲染出错: ${e.message ?: e.toString()}"
                textSize = 13f
                setTextColor(getColor(R.color.bad))
                setPadding((14 * d).toInt(), (10 * d).toInt(), (14 * d).toInt(), (10 * d).toInt())
            })
        }
    }

    private fun renderTraceInner() {
        val nowMs = System.currentTimeMillis()
        val dayStart = java.util.Calendar.getInstance().apply {
            timeInMillis = nowMs
            set(java.util.Calendar.HOUR_OF_DAY, 0); set(java.util.Calendar.MINUTE, 0)
            set(java.util.Calendar.SECOND, 0); set(java.util.Calendar.MILLISECOND, 0)
        }.timeInMillis
        val dayEnd = dayStart + 86_400_000L
        val density = resources.displayMetrics.density
        fun dpf(v: Number): Int = (v.toFloat() * density).toInt()
        val hourPx = dpf(92f)            // X 轴: 每小时 92dp(左右滑动看全天)
        val dayPx = 24 * hourPx
        val rowH = dpf(40f)              // 色块行高
        val rowPitch = dpf(46f)          // 行距(40 行高 + 6 间隙)
        val ver = try { packageManager.getPackageInfo(packageName, 0).versionName } catch (_: Exception) { "?" }

        // 顶部说明
        traceBox.addView(TextView(this).apply {
            text = "📅 今日瀑布流 v$ver · 左右滑动看全天 · 色块宽=所需时间 · 重叠自动换行 · 按住色块左右拖动=改时间 · 浅色背景=时段"
            textSize = 12f
            setTextColor(getColor(R.color.ink3))
            setPadding(dpf(2f), dpf(10f), dpf(2f), dpf(6f))
        })

        // 所有未删除时段(取色用; 今日生效的画背景带)
        val periods = app.periodStore.active()
        val occupied = periods.mapNotNull { it.colorSlot }.toSet()
        fun slotOf(id: String): Period? = periods.firstOrNull { it.id == id }

        // 今日未完成、带时间的事项
        val items = app.store.active()
            .filter { !it.isDone && it.dueAt != null && it.dueAt!! >= dayStart && it.dueAt!! < dayEnd }
            .map { t ->
                val s = ((t.dueAt!! - dayStart) / 60_000L).toInt().coerceIn(0, 1439)
                val dur = (t.durationMin ?: 0).takeIf { it > 0 } ?: 25
                val e = Math.min(1440, Math.max(s + 18, s + dur)) // 至少 18 分钟宽(与网页版一致)
                Triple(t, s, e)
            }
            .sortedBy { it.second }

        if (items.isEmpty()) {
            traceBox.addView(TextView(this).apply {
                text = "🗓\n今天还没有带时间的事项\n新建待办并设定时间后, 会以瀑布流显示在这里"
                textSize = 14f
                gravity = android.view.Gravity.CENTER
                setTextColor(getColor(R.color.ink2))
                setLineSpacing(dpf(6f).toFloat(), 1f)
                setPadding(dpf(10f), dpf(46f), dpf(10f), dpf(30f))
            })
            return
        }

        // 瀑布流行分配(贪心): 每行记“占用到的结束分钟”, 与新事项重叠则另起一行
        val rows = ArrayList<MutableList<Triple<Todo, Int, Int>>>()
        val rowsEnd = ArrayList<Int>()
        for ((t, s, e) in items) {
            var placed = false
            for (i in rowsEnd.indices) {
                if (rowsEnd[i] <= s) { rowsEnd[i] = e; rows[i].add(Triple(t, s, e)); placed = true; break }
            }
            if (!placed) { rowsEnd.add(e); rows.add(mutableListOf(Triple(t, s, e))) }
        }
        val bodyH = rowH + (rows.size - 1) * rowPitch + dpf(6)

        // 双状态时段名(与网页版 periodDisplayName 一致): 此刻在激活范围内 → 用 name; 否则用 idleName(留空沿用 name)
        val nowMin = java.util.Calendar.getInstance().apply { timeInMillis = nowMs }
            .let { it.get(java.util.Calendar.HOUR_OF_DAY) * 60 + it.get(java.util.Calendar.MINUTE) }
        fun activeAt(p: Period, m: Int): Boolean {
            for ((s, e) in p.nodes) {
                if (e < s) { if (m >= s || m < e) return true } else if (m >= s && m < e) return true
            }
            return false
        }
        fun dispName(p: Period): String =
            if (activeAt(p, nowMin)) p.name.ifBlank { p.idleName } else p.idleName.ifBlank { p.name }

        val calD = java.util.Calendar.getInstance()
        val bands = ArrayList<Triple<Period, Int, Int>>() // (时段, 段开始分钟, 段结束分钟)
        for (p in periods) {
            if (!com.todoreminder.app.data.periodActiveOnDay(p, calD)) continue
            for (seg in com.todoreminder.app.data.periodDaySegments(p)) {
                if (seg.second > seg.first) bands += Triple(p, seg.first, seg.second)
            }
        }

        // ---------- 组装: 尺标行 + 画布(刻度/背景带/色块/当前时刻线) ----------
        val column = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            layoutParams = android.widget.FrameLayout.LayoutParams(dayPx, android.widget.LinearLayout.LayoutParams.WRAP_CONTENT)
        }

        // 尺标行: 每小时标签 + 底部细线
        val ruler = android.widget.FrameLayout(this).apply {
            layoutParams = android.widget.LinearLayout.LayoutParams(dayPx, dpf(19f))
        }
        val rulerCol = android.graphics.Color.parseColor("#9AA1AD")
        for (h in 0..24) {
            ruler.addView(TextView(this).apply {
                text = String.format("%02d:00", h)
                textSize = 8.5f
                setTextColor(rulerCol)
                layoutParams = android.widget.FrameLayout.LayoutParams(
                    android.widget.FrameLayout.LayoutParams.WRAP_CONTENT, dpf(16f),
                ).apply { leftMargin = Math.max(0, h * hourPx - dpf(15)); topMargin = dpf(1) }
            })
        }
        ruler.addView(View(this).apply {
            setBackgroundColor(0xFFE6E9F0.toInt())
            layoutParams = android.widget.FrameLayout.LayoutParams(dayPx, dpf(1f)).apply { topMargin = dpf(18) }
        })
        column.addView(ruler)

        // 画布
        val host = android.widget.FrameLayout(this).apply {
            layoutParams = android.widget.LinearLayout.LayoutParams(dayPx, bodyH)
        }
        // 1) 小时刻度线(整点更明显): 3h 处 55% 灰, 其余 16% 灰 —— 与网页版 .tfline 一致
        val tickBase = 0xFF8A94A6.toInt() and 0xFFFFFF
        for (h in 0..24) {
            val col = tickBase or (if (h % 3 == 0) (0x8C shl 24) else (0x29 shl 24))
            host.addView(View(this).apply {
                setBackgroundColor(col)
                layoutParams = android.widget.FrameLayout.LayoutParams(dpf(1f), bodyH).apply {
                    leftMargin = h * hourPx
                }
            })
        }
        // 2) 今日生效时段: 大面积浅色背景垫底(22% 透明度, 左侧深色竖条 + 名称/时间), 不可拖动
        for ((p, segS, segE) in bands) {
            val slot = p.colorSlot ?: Palette.effectiveSlot(p.priority, p.colorSlot, occupied)
            val deepC = android.graphics.Color.parseColor(Palette.DEEP[slot])
            val tintC = (android.graphics.Color.parseColor(Palette.BASE[slot]) and 0xFFFFFF) or (0x38 shl 24) // 22%
            val band = android.widget.FrameLayout(this).apply {
                background = android.graphics.drawable.GradientDrawable().apply {
                    cornerRadius = dpf(8f).toFloat()
                    setColor(tintC)
                }
                layoutParams = android.widget.FrameLayout.LayoutParams(
                    ((segE - segS) * hourPx) / 60, bodyH - dpf(4f),
                ).apply { leftMargin = (segS * hourPx) / 60; topMargin = dpf(2f) }
            }
            band.addView(View(this).apply {
                setBackgroundColor(deepC)
                layoutParams = android.widget.FrameLayout.LayoutParams(dpf(3f), android.widget.FrameLayout.LayoutParams.MATCH_PARENT)
            })
            val lab = android.widget.LinearLayout(this).apply {
                orientation = android.widget.LinearLayout.VERTICAL
                layoutParams = android.widget.FrameLayout.LayoutParams(
                    android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
                    android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
                ).apply { leftMargin = dpf(6f); topMargin = dpf(2f) }
            }
            lab.addView(TextView(this).apply {
                text = dispName(p)
                textSize = 10f
                setTextColor(deepC)
                maxLines = 1
            })
            lab.addView(TextView(this).apply {
                text = com.todoreminder.app.data.fmtMin(segS) + "–" + com.todoreminder.app.data.fmtMin(segE)
                textSize = 8.5f
                setTextColor((deepC and 0xFFFFFF) or (0xC0 shl 24))
                maxLines = 1
            })
            band.addView(lab)
            host.addView(band)
        }
        // 3) 色块行
        for ((ri, rowItems) in rows.withIndex()) {
            val row = android.widget.FrameLayout(this).apply {
                layoutParams = android.widget.FrameLayout.LayoutParams(dayPx, rowH).apply {
                    topMargin = if (ri == 0) dpf(2) else dpf(2) + ri * rowPitch
                }
            }
            for ((t, s0, e0) in rowItems) {
                val slotP = slotOf(t.slotId)
                val (fillHex, lineHex) = if (slotP != null) {
                    val slot = slotP.colorSlot ?: Palette.effectiveSlot(slotP.priority, slotP.colorSlot, occupied)
                    Palette.BASE[slot] to Palette.DEEP[slot]
                } else when (t.importance) {
                    2 -> "#f8c9cf" to "#d33f49"
                    0 -> "#cfe3ff" to "#3b6fd4"
                    else -> "#f7e0bd" to "#b9762a"
                }
                val gd = android.graphics.drawable.GradientDrawable().apply {
                    cornerRadius = dpf(8f).toFloat()
                    setColor(android.graphics.Color.parseColor(fillHex))
                    setStroke(dpf(1.5f), android.graphics.Color.parseColor(lineHex))
                }
                val pre = if (t.fuzzy) "🌫 " else ""
                val dot = "● "
                val ss = android.text.SpannableStringBuilder(pre).append(dot).append(t.title)
                if (t.location.isNotBlank()) ss.append(" 📍").append(t.location)
                ss.setSpan(
                    android.text.style.ForegroundColorSpan(android.graphics.Color.parseColor(lineHex)),
                    pre.length, pre.length + dot.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
                )
                var curMin = s0
                var downX = -1f
                var moved = false
                val tv = TextView(this).apply {
                    text = ss
                    setTextColor(0xFF23272F.toInt())
                    textSize = 12f
                    typeface = android.graphics.Typeface.DEFAULT_BOLD
                    maxLines = 1
                    ellipsize = android.text.TextUtils.TruncateAt.END
                    gravity = android.view.Gravity.CENTER_VERTICAL
                    setPadding(dpf(6f), 0, dpf(4f), 0)
                    background = gd
                    if (t.fuzzy) alpha = 0.55f
                    setOnClickListener { openEdit(t) }          // 单击 → 详情
                    setOnLongClickListener { quickPlaceToToday(t); true } // 长按 → 快速改时间
                    setOnTouchListener { _, ev ->
                        when (ev.actionMasked) {
                            android.view.MotionEvent.ACTION_DOWN -> { downX = ev.rawX; moved = false; false }
                            android.view.MotionEvent.ACTION_MOVE -> {
                                if (downX < 0f) return@setOnTouchListener false
                                val dx = ev.rawX - downX
                                if (!moved && Math.abs(dx) > dpf(6f)) moved = true
                                if (moved) {
                                    val dm = (dx / (hourPx / 60f)).toInt()
                                    curMin = (s0 + dm).coerceIn(0, 1440 - (e0 - s0).coerceAtLeast(18))
                                    val lp = layoutParams as android.widget.FrameLayout.LayoutParams
                                    lp.leftMargin = (curMin * hourPx) / 60
                                    requestLayout()
                                }
                                moved
                            }
                            android.view.MotionEvent.ACTION_UP -> {
                                if (moved) {
                                    val due = dayStart + curMin * 60_000L
                                    app.store.upsert(listOf(t.copy(
                                        dueAt = due,
                                        updatedAt = System.currentTimeMillis() + app.prefs.clockSkew,
                                    )))
                                    moved = false; downX = -1f
                                    refresh()
                                    pushChanges()
                                    true
                                } else { downX = -1f; false }
                            }
                            else -> { moved = false; downX = -1f; false }
                        }
                    }
                }
                // Spannable 文本(● 用边框色)
                tv.text = ss
                row.addView(tv, android.widget.FrameLayout.LayoutParams(
                    ((e0 - s0) * hourPx) / 60, android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                ).apply {
                    leftMargin = (s0 * hourPx) / 60
                    topMargin = dpf(2f)
                    bottomMargin = dpf(2f)
                })
            }
            host.addView(row)
        }
        // 4) 当前时刻红线(2dp, 置顶不拦截触摸)
        val nowCol = (0xD33F49 and 0xFFFFFF) or (0xBF shl 24)
        host.addView(View(this).apply {
            setBackgroundColor(nowCol)
            layoutParams = android.widget.FrameLayout.LayoutParams(dpf(2f), bodyH).apply {
                leftMargin = ((nowMin.coerceIn(0, 1440) * hourPx) / 60).coerceAtMost(dayPx - dpf(2))
            }
        })
        column.addView(host)

        // 横向滚动容器 + 统计注脚
        val hsv = android.widget.HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            isVerticalScrollBarEnabled = false
        }
        hsv.addView(column)
        traceBox.addView(hsv)
        traceBox.addView(TextView(this).apply {
            text = "${items.size} 项 · 排 ${rows.size} 行(重叠自动换行) · 浅色背景 = 今日时段, 不参与拖动 · v$ver"
            textSize = 11f
            setTextColor(getColor(R.color.ink3))
            setPadding(dpf(2f), dpf(5f), dpf(2f), dpf(2f))
        })
        // 回到当前时间附近(约前 60 分钟处)
        hsv.post {
            val target = Math.max(0, ((nowMin - 60) * hourPx) / 60)
            hsv.scrollTo(Math.min(target, dayPx - dpf(260f)), 0)
        }
    }

    /** 手机端轨迹页“手动落位”: 长按任务 → 选今天时刻 → 选泳道(时段) → 保存 */
    private fun quickPlaceToToday(t: Todo) {
        val cal = java.util.Calendar.getInstance()
        val due = t.dueAt
        if (due != null) cal.timeInMillis = due
        val day = java.util.Calendar.getInstance().apply {
            set(java.util.Calendar.HOUR_OF_DAY, 0); set(java.util.Calendar.MINUTE, 0)
            set(java.util.Calendar.SECOND, 0); set(java.util.Calendar.MILLISECOND, 0)
        }
        android.app.TimePickerDialog(
            this,
            { _, hh, mm ->
                val periods = app.periodStore.active()
                    .filter { it.startMin != null && com.todoreminder.app.data.periodActiveOnDay(it, java.util.Calendar.getInstance()) }
                    .sortedWith(compareByDescending<Period> { it.priority }.thenBy { it.startMin ?: 1440 })
                val names = mutableListOf("未安排(默认泳道)")
                names += periods.map { "${it.name} ${com.todoreminder.app.data.fmtMin(it.startMin)}–${com.todoreminder.app.data.fmtMin(it.endMin)}" }
                AlertDialog.Builder(this)
                    .setTitle("「${t.title}」 放到哪个泳道?(时间: ${String.format("%02d:%02d", hh, mm)})")
                    .setItems(names.toTypedArray()) { d, w ->
                        val newDue = day.timeInMillis + (hh * 60 + mm) * 60_000L
                        val slotId = if (w <= 0) "" else periods.getOrNull(w - 1)?.id ?: ""
                        val next = t.copy(
                            dueAt = newDue, slotId = slotId,
                            updatedAt = System.currentTimeMillis() + app.prefs.clockSkew,
                        )
                        app.store.upsert(listOf(next))
                        d.dismiss()
                        toast("已落到今天 ${String.format("%02d:%02d", hh, mm)}")
                        refresh(); pushChanges()
                    }
                    .setNegativeButton("取消", null)
                    .show()
            },
            cal.get(java.util.Calendar.HOUR_OF_DAY), cal.get(java.util.Calendar.MINUTE), true,
        ).show()
    }

    // ---------- AI 截图建任务(调电脑端 /api/ai/parse, 密钥与模型配置在电脑上) ----------
    private fun aiCreateFromImage(uri: android.net.Uri) {
        if (aiBusy) return
        aiBusy = true
        btnAi.text = "…"
        Thread {
            var draft: Todo? = null
            var timetable: org.json.JSONArray? = null
            var monday: String? = null
            var err: String? = null
            try {
                val bmp0 = contentResolver.openInputStream(uri)?.use {
                    android.graphics.BitmapFactory.decodeStream(it)
                } ?: throw Exception("无法读取图片")
                val sc = Math.min(1f, 1024f / Math.max(bmp0.width, bmp0.height))
                val w = Math.max(1, Math.round(bmp0.width * sc))
                val h = Math.max(1, Math.round(bmp0.height * sc))
                val bmp = android.graphics.Bitmap.createScaledBitmap(bmp0, w, h, true)
                if (bmp !== bmp0) bmp0.recycle()
                val bos = java.io.ByteArrayOutputStream()
                bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 82, bos)
                bmp.recycle()
                val dataUrl = "data:image/jpeg;base64," +
                    android.util.Base64.encodeToString(bos.toByteArray(), android.util.Base64.NO_WRAP)
                val body = org.json.JSONObject().put("image", dataUrl)
                val client = okhttp3.OkHttpClient()
                val req = okhttp3.Request.Builder()
                    .url(app.prefs.serverUrl + "/api/ai/parse")
                    .addHeader("x-token", app.prefs.token)
                    .post(body.toString().toRequestBody("application/json; charset=utf-8".toMediaType()))
                    .build()
                client.newCall(req).execute().use { resp ->
                    val txt = resp.body?.string() ?: ""
                    val j = try { org.json.JSONObject(txt) } catch (e: Exception) { throw Exception("AI 返回异常(HTTP ${resp.code})") }
                    if (!j.optBoolean("ok", false)) {
                        err = j.optString("error", "AI 解析失败(HTTP ${resp.code})")
                    } else {
                        val f = j.getJSONObject("fields")
                        if (f.optString("kind") == "timetable") {
                            timetable = f.optJSONArray("courses")
                            monday = f.optString("mondayIso", "").takeIf { it.isNotBlank() }
                        } else {
                        val o = Todo.toJson(Todo.fresh())
                        o.put("title", f.optString("title").ifBlank { "截图待办" })
                        o.put("notes", f.optString("notes"))
                        o.put("location", f.optString("location"))
                        val mats = org.json.JSONArray()
                        val ma = f.optJSONArray("materials")
                        if (ma != null) for (i in 0 until ma.length()) {
                            ma.optString(i).trim().takeIf { it.isNotEmpty() }?.let { mats.put(it) }
                        }
                        o.put("materials", mats)
                        if (!f.isNull("durationMin")) o.put("durationMin", f.optInt("durationMin", 0).coerceIn(1, 10080))
                        else o.put("durationMin", org.json.JSONObject.NULL)
                        if (!f.isNull("importance")) o.put("importance", f.optInt("importance", 1).coerceIn(0, 2))
                        if (!f.isNull("independent")) o.put("independent", f.optBoolean("independent", true))
                        if (!f.isNull("dueAt")) o.put("dueAt", f.getLong("dueAt"))
                        else o.put("dueAt", org.json.JSONObject.NULL)
                        draft = Todo.fromJson(o)
                        }
                    }
                }
            } catch (e: Exception) {
                err = e.message ?: "解析失败"
            }
            runOnUiThread {
                aiBusy = false
                btnAi.text = "AI"
                val tArr = timetable
                val mondayIso = monday
                val d = draft
                if (tArr != null && tArr.length() > 0) {
                    confirmTimetableImport(tArr, mondayIso)
                } else if (d != null) {
                    openEdit(d, prefill = true)
                } else {
                    val hint = if ((err ?: "").contains("API Key")) "\n请在电脑网页「设置 → 🤖 AI 建任务」填好 Key 后重试" else ""
                    toast("AI: " + (err ?: "未知错误") + hint)
                }
            }
        }.start()
    }

    // ---------- 课表导入(按周日期): 每节课 → 具体日期的待办(每周课表不同, 不设重复) ----------
    private fun confirmTimetableImport(arr: org.json.JSONArray, monday: String?) {
        if (monday.isNullOrBlank()) {
            toast("图中未读到日期/周次(如“第2周 2026-09-14/09-20”) — 请用带日期的课表截图")
            return
        }
        val fmt = { ms: Long ->
            val c = java.util.Calendar.getInstance().apply { timeInMillis = ms }
            String.format("%d月%d日 %02d:%02d", c.get(java.util.Calendar.MONTH) + 1, c.get(java.util.Calendar.DAY_OF_MONTH),
                c.get(java.util.Calendar.HOUR_OF_DAY), c.get(java.util.Calendar.MINUTE))
        }
        val sb = StringBuilder()
        var shown = 0
        for (i in 0 until arr.length()) {
            val c = arr.optJSONObject(i) ?: continue
            if (c.isNull("dueAt")) continue
            sb.append(fmt(c.getLong("dueAt"))).append(' ').append(c.optString("name"))
            val loc = c.optString("location").ifBlank { c.optString("env") }.trim()
            if (loc.isNotEmpty()) sb.append(" 📍").append(loc)
            sb.append('\n')
            shown++
            if (shown >= 12) break
        }
        AlertDialog.Builder(this)
            .setTitle("识别为 $monday 当周课表, 共 $shown 节")
            .setMessage(sb.toString().trim() + "\n\n按“具体日期”写入待办(不是每周重复; 每周换课表就每周导一次, 提前10分钟提醒)?")
            .setPositiveButton("写入") { _, _ -> importTimetable(arr) }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun importTimetable(arr: org.json.JSONArray) {
        val existing = app.store.active()
        var added = 0
        var skip = 0
        for (i in 0 until arr.length()) {
            val c = arr.optJSONObject(i) ?: continue
            if (c.isNull("dueAt")) continue
            val name = c.optString("name").trim()
            if (name.isEmpty()) continue
            val dueAt = c.getLong("dueAt")
            val loc = c.optString("location").ifBlank { c.optString("env") }.trim()
            val dur = if (c.isNull("durationMin")) null else c.optInt("durationMin", 0).takeIf { it > 0 }
            if (existing.any { !it.deleted && it.title == name && it.dueAt == dueAt }) { skip++; continue }
            val now = System.currentTimeMillis() + app.prefs.clockSkew
            val t = Todo.fresh().copy(
                title = name,
                location = loc,
                dueAt = dueAt,
                durationMin = dur,
                remindBeforeMin = 10,
                importance = 1,
                independent = true,
                status = "todo",
                repeat = "none",
                fuzzy = false,
                createdAt = now,
                updatedAt = now,
            )
            app.store.upsert(listOf(t))
            added++
        }
        refresh()
        pushChanges()
        toast("课表已按日期写入: 新增 $added 节" + (if (skip > 0) ", 跳过重复 $skip 节" else ""))
    }

    private fun updateChipCounts(now: Long) {
        val active = app.store.active()
        fun lf(t: Todo) = Fmt.life(t, now)
        val c = mapOf(
            "all" to active.count { lf(it) != "done" },
            "todo" to active.count { lf(it) != "done" },
            "done" to active.count { it.isDone },
            "today" to active.count { val l = lf(it); l != "done" && Fmt.bucket(it.dueAt, now) == "today" },
            "overdue" to active.count { lf(it) == "overdue" },
        )
        for (i in 0 until chipsStatus.childCount) {
            val chip = chipsStatus.getChildAt(i) as Chip
            val key = when (i) { 0 -> "all"; 1 -> "today"; 2 -> "todo"; 3 -> "done"; else -> "overdue" }
            val base = when (i) { 0 -> "全部"; 1 -> "今天"; 2 -> "未完成"; 3 -> "已完成"; else -> "已逾期" }
            chip.text = "$base(${c[key]})"
        }
        sortText.text = sortLabel()
        groupText.text = groupLabel()
        tvLastSync.text = if (app.prefs.lastSyncedAt > 0) "上次同步 ${Fmt.hmText(app.prefs.lastSyncedAt)}" else ""
    }

    private fun openEdit(t: Todo?, prefill: Boolean = false) {
        val i = Intent(this, EditTodoActivity::class.java)
        if (t != null) i.putExtra(if (prefill) "prefill" else "todo", Todo.toJson(t).toString())
        // 附带时段库(按优先度), 供编辑页选择挂靠
        val arr = JSONArray()
        app.periodStore.active()
            .sortedWith(compareByDescending<Period> { it.priority }.thenBy { it.startMin ?: 1440 })
            .forEach { arr.put(Period.toJson(it)) }
        i.putExtra("periods", arr.toString())
        editLauncher.launch(i)
    }

    // ---------- TodoAdapter.Listener ----------
    override fun onToggle(t: Todo) {
        val completing = !t.isDone
        val skew = app.prefs.clockSkew
        val next = if (completing && t.repeat != "none" && t.dueAt != null) {
            // 重复触发: 勾选完成 → 自动滚到下一周期
            val nxt = com.todoreminder.app.data.nextOccurrenceMs(t, System.currentTimeMillis())
            val due = t.dueAt!!
            t.copy(
                dueAt = if (nxt != null && nxt > due) nxt else due,
                status = "todo",
                updatedAt = System.currentTimeMillis() + skew,
            )
        } else {
            t.withStatus(if (t.isDone) "todo" else "done", skew)
        }
        app.store.upsert(listOf(next))
        refresh(); pushChanges()
    }

    override fun onClick(t: Todo) = openEdit(t)

    override fun onMenu(t: Todo, anchor: View) {
        val pm = PopupMenu(this, anchor)
        pm.menu.add(0, 1, 0, if (t.status == "doing") "取消进行中" else "标记进行中")
        pm.menu.add(0, 2, 1, "编辑")
        pm.menu.add(0, 3, 2, "删除")
        pm.setOnMenuItemClickListener { mi ->
            when (mi.itemId) {
                1 -> {
                    app.store.upsert(listOf(t.withStatus(if (t.status == "doing") "todo" else "doing", app.prefs.clockSkew)))
                    refresh(); pushChanges()
                }
                2 -> openEdit(t)
                3 -> AlertDialog.Builder(this)
                    .setMessage("删除「${t.title}」?")
                    .setPositiveButton("删除") { _, _ ->
                        app.store.upsert(listOf(t.markDeleted(app.prefs.clockSkew)))
                        refresh(); pushChanges()
                    }.setNegativeButton("取消", null).show()
            }
            true
        }
        pm.show()
    }

    override fun onHeaderTap(key: String) {
        if (collapsed.contains(key)) collapsed.remove(key) else collapsed.add(key)
        refresh()
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
}
