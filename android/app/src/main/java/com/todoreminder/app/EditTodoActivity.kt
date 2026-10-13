package com.todoreminder.app

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.AppCompatRadioButton
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import com.todoreminder.app.data.Todo
import java.util.Calendar

/** 新建/编辑待办 */
class EditTodoActivity : AppCompatActivity() {

    private lateinit var t: Todo
    private var isEdit = false
    private var dueEdit = false

    private lateinit var etTitle: EditText
    private lateinit var etNotes: EditText
    private lateinit var etLocation: EditText
    private lateinit var etDuration: EditText
    private lateinit var etMaterials: EditText
    private lateinit var suggTitle: LinearLayout
    private lateinit var suggLocation: LinearLayout
    private lateinit var suggMaterials: LinearLayout
    private lateinit var spinnerSlot: Spinner
    private lateinit var swIndependent: androidx.appcompat.widget.SwitchCompat
    private lateinit var tvTime: TextView
    private lateinit var btnPickTime: Button
    private lateinit var spinnerRemind: Spinner
    private lateinit var spinnerRepeat: Spinner
    private lateinit var swFuzzy: androidx.appcompat.widget.SwitchCompat
    private lateinit var chipMats: ChipGroup
    private lateinit var btnSave: Button
    private lateinit var btnDelete: Button
    private var slotPeriods: List<com.todoreminder.app.data.Period> = emptyList()

    private val remindValues = intArrayOf(0, 5, 10, 15, 30, 60, 120, 1440, 2880)
    private val remindLabels = arrayOf(
        "准时提醒", "提前 5 分钟", "提前 10 分钟", "提前 15 分钟", "提前 30 分钟",
        "提前 1 小时", "提前 2 小时", "提前 1 天", "提前 2 天",
    )
    private val repeatValues = arrayOf("none", "daily", "weekly", "monthly")
    private val repeatLabels = arrayOf("不重复", "每天", "每周", "每月")
    private val sugHandler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_edit)
        bindViews()

        val json = intent.getStringExtra("todo")
        val prefillJson = intent.getStringExtra("prefill")
        t = when {
            json != null -> {
                isEdit = true
                Todo.fromJson(org.json.JSONObject(json))
            }
            prefillJson != null -> Todo.fromJson(org.json.JSONObject(prefillJson)) // AI 截图草稿: 仍按“新建”保存
            else -> Todo.fresh()
        }

        // 提醒下拉 adapter 必须先于 fillForm 挂载, 否则 setSelection 无效 → 保存恒为“准时提醒”
        spinnerRemind.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, remindLabels)
            .apply { setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }

        fillForm()
        // 历史输入联想: 输入时在输入框下方弹出“过去输入过的内容”, 点选填入
        // (自绘按钮列表, 不用系统 AutoComplete 下拉 — 手机输入法下点选更可靠)
        bindSug(etTitle, suggTitle, "title", "") { text ->
            etTitle.setText(text); etTitle.setSelection(text.length)
        }
        bindSug(etLocation, suggLocation, "location", "📍 ") { text ->
            etLocation.setText(text); etLocation.setSelection(text.length)
        }
        bindSug(etMaterials, suggMaterials, "material", "🧰 ") { text ->
            addChipUi(text)
            etMaterials.setText("")
        }
        findViewById<ImageButton>(R.id.btnClose).setOnClickListener { finish() }
        btnPickTime.setOnClickListener { pickDateTime() }
        findViewById<Button>(R.id.btnClearTime).setOnClickListener {
            t = t.copy(dueAt = null, repeat = "none")
            spinnerRepeat.setSelection(0)
            renderTime()
        }

        // 快捷时间: 1小时后 / 今天18:00 / 明天9:00 / 明天18:00
        setupQuickTimes()

        btnSave.setOnClickListener { save() }
        if (isEdit) {
            btnDelete.visibility = View.VISIBLE
            btnDelete.setOnClickListener {
                (application as App).store.upsert(
                    listOf(t.markDeleted((application as App).prefs.clockSkew)),
                )
                pushAndFinish()
            }
        }
    }

    private fun bindViews() {
        etTitle = findViewById(R.id.etTitle)
        etNotes = findViewById(R.id.etNotes)
        etLocation = findViewById(R.id.etLocation)
        etDuration = findViewById(R.id.etDuration)
        etMaterials = findViewById(R.id.etMaterials)
        swIndependent = findViewById(R.id.swIndependent)
        tvTime = findViewById(R.id.tvTime)
        btnPickTime = findViewById(R.id.btnPickTime)
        spinnerRemind = findViewById(R.id.spinnerRemind)
        spinnerRepeat = findViewById(R.id.spinnerRepeat)
        swFuzzy = findViewById(R.id.swFuzzy)
        // 重复下拉 adapter 同样先于 fillForm 挂载
        spinnerRepeat.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, repeatLabels)
            .apply { setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        chipMats = findViewById(R.id.chipMats)
        btnSave = findViewById(R.id.btnSave)
        btnDelete = findViewById(R.id.btnDelete)
        spinnerSlot = findViewById(R.id.spinnerSlot)
        suggTitle = findViewById(R.id.suggTitle)
        suggLocation = findViewById(R.id.suggLocation)
        suggMaterials = findViewById(R.id.suggMaterials)
        // 时段库(来自主界面)
        try {
            val raw = intent.getStringExtra("periods")
            if (raw != null) {
                val arr = org.json.JSONArray(raw)
                val list = mutableListOf<com.todoreminder.app.data.Period>()
                for (i in 0 until arr.length()) list += com.todoreminder.app.data.Period.fromJson(arr.getJSONObject(i))
                slotPeriods = list
            }
        } catch (e: Exception) { slotPeriods = emptyList() }
        val slotNames = listOf("未安排(默认泳道)") + slotPeriods.map {
            it.name + " " + com.todoreminder.app.data.fmtMin(it.startMin)
        }
        spinnerSlot.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, slotNames)
            .apply { setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        val swDue = findViewById<androidx.appcompat.widget.SwitchCompat>(R.id.swDue)
        dueEdit = swDue.isChecked
        swDue.setOnCheckedChangeListener { _, on ->
            dueEdit = on
            btnPickTime.visibility = if (on) View.VISIBLE else View.GONE
            if (!on) {
                t = t.copy(dueAt = null, repeat = "none")
                spinnerRepeat.setSelection(0)
            }
            renderTime()
        }
        findViewById<Button>(R.id.btnAddMat).setOnClickListener { addMaterialChip() }
        etMaterials.setOnEditorActionListener { _, _, _ ->
            addMaterialChip(); false
        }
    }

    private fun fillForm() {
        etTitle.setText(t.title)
        etNotes.setText(t.notes)
        etLocation.setText(t.location)
        etDuration.setText(t.durationMin?.toString() ?: "")
        swIndependent.isChecked = t.independent
        when (t.importance) {
            0 -> findViewById<AppCompatRadioButton>(R.id.rbImpLow).isChecked = true
            2 -> findViewById<AppCompatRadioButton>(R.id.rbImpHigh).isChecked = true
            else -> findViewById<AppCompatRadioButton>(R.id.rbImpMid).isChecked = true
        }
        dueEdit = t.dueAt != null
        findViewById<androidx.appcompat.widget.SwitchCompat>(R.id.swDue).isChecked = dueEdit
        btnPickTime.visibility = if (dueEdit) View.VISIBLE else View.GONE
        val si = slotPeriods.indexOfFirst { it.id == t.slotId }
        spinnerSlot.setSelection(if (si >= 0) si + 1 else 0)
        val idx = remindValues.indexOf(t.remindBeforeMin).coerceAtLeast(0)
        spinnerRemind.setSelection(idx)
        spinnerRepeat.setSelection(repeatValues.indexOf(t.repeat).coerceAtLeast(0))
        swFuzzy.isChecked = t.fuzzy
        for (m in t.materials) addChipUi(m)
        renderTime()
    }

    private fun renderTime() {
        val due = t.dueAt
        tvTime.text = if (due != null) formatDue(due) else "未设定具体时间"
        tvTime.setTextColor(
            if (due != null) getColor(R.color.ink)
            else getColor(R.color.ink3),
        )
    }

    private fun formatDue(ms: Long): String {
        val c = Calendar.getInstance().apply { timeInMillis = ms }
        val now = Calendar.getInstance()
        val sameDay = c.get(Calendar.YEAR) == now.get(Calendar.YEAR) &&
            c.get(Calendar.DAY_OF_YEAR) == now.get(Calendar.DAY_OF_YEAR)
        val tomorrow = Calendar.getInstance().apply { add(Calendar.DAY_OF_YEAR, 1) }
        val isTomorrow = c.get(Calendar.YEAR) == tomorrow.get(Calendar.YEAR) &&
            c.get(Calendar.DAY_OF_YEAR) == tomorrow.get(Calendar.DAY_OF_YEAR)
        val fmt = java.text.SimpleDateFormat(
            when {
                sameDay -> "今天 HH:mm"
                isTomorrow -> "明天 HH:mm"
                else -> "M月d日 HH:mm"
            },
            java.util.Locale.getDefault(),
        )
        return fmt.format(c.time)
    }

    private fun pickDateTime() {
        val due = t.dueAt
        val cal = Calendar.getInstance().apply {
            if (due != null) timeInMillis = due
        }
        DatePickerDialog(
            this, { _, y, m, d ->
                val c = Calendar.getInstance()
                c.set(Calendar.YEAR, y); c.set(Calendar.MONTH, m); c.set(Calendar.DAY_OF_MONTH, d)
                TimePickerDialog(this, { _, hh, mm ->
                    c.set(Calendar.HOUR_OF_DAY, hh); c.set(Calendar.MINUTE, mm); c.set(Calendar.SECOND, 0)
                    t = t.copy(dueAt = c.timeInMillis)
                    renderTime()
                }, cal.get(Calendar.HOUR_OF_DAY), cal.get(Calendar.MINUTE), true).show()
            },
            cal.get(Calendar.YEAR), cal.get(Calendar.MONTH), cal.get(Calendar.DAY_OF_MONTH),
        ).show()
    }

    private fun setupQuickTimes() {
        val chipGroup: ChipGroup = findViewById(R.id.chipQuick)
        // 今天 HH:00 若已过会自动顺延到明天 — 按钮文字同步显示“明天”, 避免误导
        val quick = listOf<Pair<() -> String, () -> Long>>(
            { "1 小时后" } to { System.currentTimeMillis() + 3600_000L },
            { quickDayLabel(18, 0) } to { nextAt(18, 0) },
            { quickDayLabel(9, 1) } to { nextAt(9, 0, 1) },
            { quickDayLabel(18, 1) } to { nextAt(18, 0, 1) },
        )
        for ((labelFn, fn) in quick) {
            chipGroup.addView(Chip(this).apply {
                text = labelFn()
                setOnClickListener {
                    val due = fn()
                    t = t.copy(dueAt = due)
                    dueEdit = true
                    findViewById<androidx.appcompat.widget.SwitchCompat>(R.id.swDue).isChecked = true
                    btnPickTime.visibility = View.VISIBLE
                    renderTime()
                    tvTime.setTextColor(getColor(R.color.ok))
                    val base = (text as? CharSequence)?.toString() ?: ""
                    val rolled = base.startsWith("今天") && due == todayAtRaw(18, 0) + 86_400_000L
                    if (rolled) toast("今天 18:00 已过 → 已自动排到: " + formatDue(due))
                    else toast("✅ 时间已设为: " + formatDue(due))
                }
            })
        }
    }

    /** 按钮文案: 今天/明天 HH:00(若“今天”时刻已过则显示“明天”) */
    private fun quickDayLabel(hour: Int, dayOffset: Int): String {
        if (dayOffset > 0) return String.format("明天 %02d:00", hour)
        val c = Calendar.getInstance()
        c.set(Calendar.HOUR_OF_DAY, hour); c.set(Calendar.MINUTE, 0); c.set(Calendar.SECOND, 0)
        val prefix = if (c.timeInMillis > System.currentTimeMillis()) "今天" else "明天"
        return String.format("$prefix %02d:00", hour)
    }

    private fun todayAtRaw(hour: Int, minute: Int): Long {
        val c = Calendar.getInstance()
        c.set(Calendar.HOUR_OF_DAY, hour); c.set(Calendar.MINUTE, minute); c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0)
        return c.timeInMillis
    }

    private fun nextAt(hour: Int, minute: Int, dayOffset: Int = 0): Long {
        val c = Calendar.getInstance()
        c.add(Calendar.DAY_OF_YEAR, dayOffset)
        c.set(Calendar.HOUR_OF_DAY, hour); c.set(Calendar.MINUTE, minute); c.set(Calendar.SECOND, 0)
        if (dayOffset == 0 && c.timeInMillis <= System.currentTimeMillis()) c.add(Calendar.DAY_OF_YEAR, 1)
        return c.timeInMillis
    }

    /** 历史词条: 从本机已同步待办提取 标题/地点/材料, 按次数→最近排序 */
    private fun historyOf(kind: String): List<String> {
        val cnt = HashMap<String, Int>()
        val last = HashMap<String, Long>()
        for (t in (application as App).store.active()) {
            val ts = maxOf(t.updatedAt, t.createdAt)
            val vals = when (kind) {
                "title" -> if (t.title.isNotBlank()) listOf(t.title.trim()) else emptyList()
                "location" -> if (t.location.isNotBlank()) listOf(t.location.trim()) else emptyList()
                else -> t.materials.map { it.trim() }.filter { it.isNotEmpty() }
            }
            for (v in vals) {
                cnt[v] = (cnt[v] ?: 0) + 1
                last[v] = maxOf(last[v] ?: 0L, ts)
            }
        }
        return cnt.keys.sortedWith(
            compareByDescending<String> { cnt[it] ?: 0 }.thenByDescending { last[it] ?: 0L },
        )
    }

    /** 输入框下方历史建议(自绘按钮, 触屏点选可靠; 空输入不打扰) */
    private fun bindSug(et: EditText, wrap: LinearLayout, kind: String, prefix: String, onPick: (String) -> Unit) {
        fun refresh() {
            if (!et.hasFocus() || wrap.parent == null) { wrap.visibility = View.GONE; return }
            val q = et.text.toString().trim()
            if (q.isEmpty()) { wrap.visibility = View.GONE; return }
            val items = historyOf(kind).filter { it.contains(q, ignoreCase = true) }.take(6)
            wrap.removeAllViews()
            if (items.isEmpty()) { wrap.visibility = View.GONE; return }
            for (item in items) {
                val b = TextView(this).apply {
                    text = prefix + item
                    textSize = 13.5f
                    setTextColor(getColor(R.color.ink))
                    setBackgroundResource(R.drawable.bg_input)
                    isClickable = true
                    isFocusable = false
                    setPadding(dp(12), dp(11), dp(12), dp(11))
                    setOnClickListener {
                        sugHandler.removeCallbacksAndMessages(null)
                        wrap.visibility = View.GONE
                        onPick(item)
                    }
                }
                wrap.addView(b, LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply { bottomMargin = dp(6) })
            }
            wrap.visibility = View.VISIBLE
        }
        et.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) { refresh() }
        })
        et.setOnFocusChangeListener { _, has ->
            sugHandler.removeCallbacksAndMessages(null)
            if (has) refresh()
            else sugHandler.postDelayed({ wrap.visibility = View.GONE }, 220)
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun addMaterialChip() {
        val raw = etMaterials.text.toString().trim()
        if (raw.isEmpty()) return
        raw.split(",", "，", ";", "；").map { it.trim() }.filter { it.isNotEmpty() }.forEach { addChipUi(it) }
        etMaterials.setText("")
    }

    private fun addChipUi(m: String) {
        val chip = Chip(this).apply {
            text = m
            isCloseIconVisible = true
            setOnCloseIconClickListener { chipMats.removeView(this) }
        }
        chipMats.addView(chip)
    }

    private fun collectMaterials(): List<String> {
        val out = mutableListOf<String>()
        for (i in 0 until chipMats.childCount) {
            (chipMats.getChildAt(i) as? Chip)?.text?.toString()?.takeIf { it.isNotBlank() }?.let { out += it.trim() }
        }
        etMaterials.text.toString().split(",", "，", ";", "；")
            .map { it.trim() }.filter { it.isNotEmpty() }.forEach { out += it }
        return out.distinct()
    }

    private fun save() {
        val title = etTitle.text.toString().trim()
        if (title.isEmpty()) { toast("请填写标题"); return }
        val importance = when {
            findViewById<AppCompatRadioButton>(R.id.rbImpLow).isChecked -> 0
            findViewById<AppCompatRadioButton>(R.id.rbImpHigh).isChecked -> 2
            else -> 1
        }
        val duration = etDuration.text.toString().trim().toIntOrNull()?.takeIf { it > 0 }
        val remind = remindValues.getOrElse(spinnerRemind.selectedItemPosition) { 15 }
        // 重复触发需要具体时间; 未设时间时强制不重复
        val repeat = repeatValues.getOrElse(spinnerRepeat.selectedItemPosition) { "none" }
            .takeIf { t.dueAt != null } ?: "none"
        val selSlot = spinnerSlot.selectedItemPosition
        val slotId = if (selSlot <= 0) "" else slotPeriods.getOrNull(selSlot - 1)?.id ?: ""

        t = t.copy(
            title = title,
            notes = etNotes.text.toString().trim(),
            location = etLocation.text.toString().trim(),
            importance = importance,
            durationMin = duration,
            slotId = slotId,
            independent = swIndependent.isChecked,
            remindBeforeMin = remind,
            repeat = repeat,
            fuzzy = swFuzzy.isChecked,
            materials = collectMaterials(),
            updatedAt = System.currentTimeMillis() + (application as App).prefs.clockSkew,
        )
        (application as App).store.upsert(listOf(t))
        pushAndFinish()
    }

    private fun pushAndFinish() {
        val app = application as App
        setResult(RESULT_OK, intent.putExtra("todo", Todo.toJson(t).toString()))
        finish()
        // 立即后台推送一次(失败则由主界面 30s 周期重试)
        app.sync.syncAsync { }
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
}
