package com.todoreminder.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import android.widget.ToggleButton
import androidx.appcompat.app.AppCompatActivity
import com.todoreminder.app.data.Period
import com.todoreminder.app.data.fmtMin
import com.todoreminder.app.data.freqLabel

/**
 * 新建/编辑时段(时段库) — 双状态时段: 激活名 name + 空闲名 idleName(留空沿用 name);
 * 时间段可多节点(nodes), 结束早于开始 = 跨午夜(次日收尾)。与电脑端网页编辑保持一致。
 */
class EditPeriodActivity : AppCompatActivity() {

    private val app: App get() = application as App
    private lateinit var t: Period
    private var isEdit = false
    private lateinit var etName: EditText
    private lateinit var etIdle: EditText
    private lateinit var etEnv: EditText
    private lateinit var nodWrap: LinearLayout
    private lateinit var rgPri: RadioGroup
    private lateinit var spFreq: Spinner
    private lateinit var weeklyWrap: LinearLayout
    private lateinit var yearlyWrap: LinearLayout
    private lateinit var spSm: Spinner; private lateinit var spSd: Spinner
    private lateinit var spEm: Spinner; private lateinit var spEd: Spinner
    private lateinit var spRemind: Spinner
    private val weekToggles = mutableListOf<ToggleButton>()

    private class NodeRow(val spS: Spinner, val spE: Spinner, val btnX: TextView)
    private val nodeRows = mutableListOf<NodeRow>()

    private val timeVals = IntArray(96) { it * 15 } // 00:00..23:45
    private val timeLabels = timeVals.map { fmtMin(it) }.toTypedArray()
    private val weekCn = arrayOf("周一", "周二", "周三", "周四", "周五", "周六", "周日")
    private val freqLabels = arrayOf("每天", "每周(选周几)", "每年某天至某天")
    private val remindValues = intArrayOf(0, 5, 10, 15, 30, 60, 120, 1440, 2880)
    private val remindLabels = arrayOf(
        "不提醒", "提前 5 分钟", "提前 10 分钟", "提前 15 分钟", "提前 30 分钟",
        "提前 1 小时", "提前 2 小时", "提前 1 天", "提前 2 天",
    )
    private val monthNames = (1..12).map { "${it}月" }.toTypedArray()
    private val dayNames = (1..31).map { "${it}日" }.toTypedArray()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "时段"
        val raw = intent.getStringExtra("period")
        t = if (raw != null) {
            isEdit = true
            Period.fromJson(org.json.JSONObject(raw))
        } else Period.fresh()
        buildUi()
    }

    private fun buildUi() {
        val dp = (8 * resources.displayMetrics.density).toInt()
        val scroll = android.widget.ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp * 2, dp, dp * 2, dp)
        }
        scroll.addView(root)
        setContentView(scroll)

        fun label(s: String): TextView = TextView(this).apply {
            text = s
            textSize = 12f
            setTextColor(getColor(R.color.ink2))
            setPadding(0, dp, 0, 0)
        }
        fun smallHint(s: String): TextView = TextView(this).apply {
            text = s
            textSize = 11f
            setTextColor(getColor(R.color.ink3))
            setPadding(0, dp / 3, 0, 0)
        }

        // ---------- 双状态: 激活名 + 空闲名 ----------
        etName = EditText(this).apply { hint = "激活时显示: 例 上午专注 / 夜班值守" }
        root.addView(label("名称(激活时显示) ※必填"))
        root.addView(etName)

        etIdle = EditText(this).apply { hint = "空闲时显示: 例 自由安排 / 夜间休息" }
        root.addView(label("空闲名(非激活时显示)"))
        smallHint("空闲名可留空 = 沿用激活名; 未激活时段会显示空闲名").also { root.addView(it) }
        root.addView(etIdle)

        // ---------- 多节点时间段 ----------
        root.addView(label("时间段(可多段)"))
        smallHint("每段 开始 → 结束; 结束早于开始 = 跨午夜(次日收尾)").also { root.addView(it) }
        nodWrap = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(nodWrap)

        val btnAdd = TextView(this).apply {
            text = "＋ 添加一段"
            textSize = 13f
            setTextColor(getColor(R.color.primary))
            setPadding(0, dp / 2, 0, 0)
            setOnClickListener {
                if (nodeRows.size >= 8) { toast("最多 8 段"); return@setOnClickListener }
                addNodeRow(defaultNodeStart(), defaultNodeEnd(), scrollToBottom = true)
            }
        }
        root.addView(btnAdd)

        etEnv = EditText(this).apply { hint = "环境内容: 例 家里/安静/需要电脑" }
        root.addView(label("环境内容"))
        root.addView(etEnv)

        rgPri = RadioGroup(this).apply { orientation = RadioGroup.HORIZONTAL }
        listOf("低" to 0, "中" to 1, "高" to 2).forEach { (lab, v) ->
            rgPri.addView(RadioButton(this).apply {
                text = lab
                tag = v
                layoutParams = RadioGroup.LayoutParams(0, RadioGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
        }
        root.addView(label("时段优先度"))
        root.addView(rgPri)

        spFreq = Spinner(this)
        root.addView(label("重复"))
        root.addView(spFreq)
        weeklyWrap = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        for (i in 0..6) {
            weeklyWrap.addView(ToggleButton(this).apply {
                textOff = weekCn[i]; textOn = weekCn[i]
                textSize = 11f
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                weekToggles += this
            })
        }
        weeklyWrap.visibility = View.GONE
        root.addView(weeklyWrap)

        yearlyWrap = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        fun spinner(): Spinner = Spinner(this)
        spSm = spinner(); spSd = spinner(); spEm = spinner(); spEd = spinner()
        yearlyWrap.addView(spSm, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        yearlyWrap.addView(spSd, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        yearlyWrap.addView(TextView(this).apply { text = "至" })
        yearlyWrap.addView(spEm, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        yearlyWrap.addView(spEd, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        yearlyWrap.visibility = View.GONE
        root.addView(yearlyWrap)

        spRemind = Spinner(this)
        root.addView(label("开始前提醒"))
        root.addView(spRemind)

        root.addView(TextView(this).apply {
            text = "泳道颜色: 保存时按优先度自动取空闲色(删除时段即释放)"
            textSize = 12f
            setTextColor(getColor(R.color.ink3))
            setPadding(0, dp, 0, 0)
        })

        val rowBtn = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp, 0, dp)
        }
        root.addView(rowBtn)
        val btnCancel = Button(this).apply { text = "取消" }
        rowBtn.addView(btnCancel, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        val btnDel = Button(this).apply { text = "删除" }
        rowBtn.addView(btnDel, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        val btnSave = Button(this).apply { text = "保存" }
        rowBtn.addView(btnSave, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

        // ---------- 数据填充 ----------
        spFreq.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, freqLabels)
            .apply { setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        spRemind.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, remindLabels)
            .apply { setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        spSm.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, monthNames).apply { setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        spSd.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, dayNames).apply { setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        spEm.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, monthNames).apply { setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        spEd.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, dayNames).apply { setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }

        etName.setText(t.name)
        etIdle.setText(t.idleName)
        etEnv.setText(t.env)
        rgPri.check(rgPri.getChildAt(t.priority).id)
        spFreq.setSelection(when (t.freq) { "weekly" -> 1; "yearly" -> 2; else -> 0 })
        spRemind.setSelection(remindValues.indexOf(t.remindBeforeMin).coerceAtLeast(0))
        (t.weekdays).forEach { w -> if (w in 1..7) weekToggles[w - 1].isChecked = true }
        val smd = t.startMD
        if (smd != null) {
            spSm.setSelection((smd / 100) - 1)
            spSd.setSelection((smd % 100) - 1)
        }
        val emd = t.endMD
        if (emd != null) {
            spEm.setSelection((emd / 100) - 1)
            spEd.setSelection((emd % 100) - 1)
        }

        // 节点: 有多节点用 nodes, 否则兼容 startMin/endMin
        val nodes = if (t.nodes.isNotEmpty()) t.nodes
        else (t.startMin?.takeIf { s -> s != t.endMin }?.let { s -> t.endMin?.let { listOf(s to it) } } ?: emptyList())
        if (nodes.isEmpty()) addNodeRow(9 * 60, 11 * 60)
        else for ((s, e) in nodes) addNodeRow(s, e)

        updateFreqVisibility()
        spFreq.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: android.widget.AdapterView<*>?, v: View?, pos: Int, id: Long) = updateFreqVisibility()
            override fun onNothingSelected(p: android.widget.AdapterView<*>?) {}
        }

        btnCancel.setOnClickListener { finish() }
        if (isEdit) btnDel.setOnClickListener {
            val del = t.copyDeleted(app.prefs.clockSkew)
            app.periodStore.upsert(listOf(del))
            setResult(Activity.RESULT_OK, Intent().putExtra("period", Period.toJson(del).toString()))
            finish()
        } else btnDel.visibility = View.GONE
        btnSave.setOnClickListener { save() }
    }

    private fun defaultNodeStart(): Int {
        // 默认取当前时刻下一整点附近, 简化: 上一节点结束或 9:00
        val lastEnd = nodeRows.lastOrNull()?.spE?.selectedItemPosition
            ?.let { timeVals.getOrElse(it) { 11 * 60 } }
        return if (lastEnd != null && lastEnd < 23 * 60 + 45) lastEnd else 9 * 60
    }

    private fun defaultNodeEnd(): Int {
        val s = defaultNodeStart()
        return Math.min(23 * 60 + 45, s + 60)
    }

    private fun addNodeRow(s: Int, e: Int, scrollToBottom: Boolean = false) {
        val dp = (8 * resources.displayMetrics.density).toInt()
        fun spin(): Spinner = Spinner(this).apply {
            adapter = ArrayAdapter(this@EditPeriodActivity, android.R.layout.simple_spinner_item, timeLabels)
                .apply { setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        }
        val spS = spin(); val spE = spin()
        spS.setSelection(timeVals.indexOf(s).coerceAtLeast(0))
        spE.setSelection(timeVals.indexOf(e).coerceAtLeast(0))
        val btnX = TextView(this).apply {
            text = "✕"
            textSize = 16f
            setTextColor(getColor(R.color.bad))
            gravity = android.view.Gravity.CENTER
            setPadding(dp / 2, 0, dp / 2, 0)
        }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(0, dp / 4, 0, 0)
            addView(spS, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(TextView(this@EditPeriodActivity).apply { text = " → " }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            addView(spE, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(btnX)
        }
        val nr = NodeRow(spS, spE, btnX)
        nodeRows += nr
        nodWrap.addView(row)
        btnX.setOnClickListener {
            nodeRows.remove(nr)
            nodWrap.removeView(row)
        }
        if (scrollToBottom) {
            (getWindow().decorView as android.view.ViewGroup).post {
                try {
                    val sv = getWindow().decorView.findViewById<android.widget.ScrollView>(android.R.id.content)
                    sv?.fullScroll(View.FOCUS_DOWN)
                } catch (_: Exception) {}
            }
        }
    }

    private fun updateFreqVisibility() {
        val freq = when (spFreq.selectedItemPosition) { 1 -> "weekly"; 2 -> "yearly"; else -> "daily" }
        weeklyWrap.visibility = if (freq == "weekly") View.VISIBLE else View.GONE
        yearlyWrap.visibility = if (freq == "yearly") View.VISIBLE else View.GONE
    }

    private fun save() {
        val name = etName.text.toString().trim()
        if (name.isEmpty()) { toast("请填写时段名称(激活时显示)"); return }
        val idleName = etIdle.text.toString().trim()
        val freq = when (spFreq.selectedItemPosition) { 1 -> "weekly"; 2 -> "yearly"; else -> "daily" }
        val weekdays = weekToggles.mapIndexedNotNull { i, b -> if (b.isChecked) i + 1 else null }
        if (freq == "weekly" && weekdays.isEmpty()) { toast("每周请至少选一天"); return }
        // 收集所有节点
        val raw = ArrayList<Pair<Int, Int>>()
        for (nr in nodeRows) {
            val s = timeVals.getOrElse(nr.spS.selectedItemPosition) { 9 * 60 }
            val e = timeVals.getOrElse(nr.spE.selectedItemPosition) { 11 * 60 }
            if (s == e) { toast("某一段的开始与结束相同, 请调整(结束早于开始 = 跨午夜)"); return }
            raw += s to e
        }
        if (raw.isEmpty()) { toast("请至少保留一段时间段"); return }
        val nodes = raw.distinct().sortedWith(compareBy({ it.first }, { it.second }))
        val startMin = nodes.first().first
        val endMin = nodes.first().second
        val startMD = if (freq == "yearly") (spSm.selectedItemPosition + 1) * 100 + (spSd.selectedItemPosition + 1) else null
        val endMD = if (freq == "yearly") (spEm.selectedItemPosition + 1) * 100 + (spEd.selectedItemPosition + 1) else null
        val priority = when (rgPri.checkedRadioButtonId) {
            rgPri.getChildAt(0).id -> 0
            rgPri.getChildAt(2).id -> 2
            else -> 1
        }
        val remind = remindValues.getOrElse(spRemind.selectedItemPosition) { 10 }

        // 颜色槽: 自动取同优先组空闲槽(删除即释放); 组满保留原值
        val occ = app.periodStore.active().filter { it.id != t.id && it.colorSlot != null }.mapNotNull { it.colorSlot }.toSet()
        val gStart = when (priority) { 2 -> 0; 1 -> 3; else -> 6 }
        var colorSlot = t.colorSlot
        if (colorSlot == null || occ.contains(colorSlot)) {
            colorSlot = (gStart until gStart + 3).firstOrNull { !occ.contains(it) }
        }

        t = t.copy(
            name = name, idleName = idleName,
            startMin = startMin, endMin = endMin, nodes = nodes,
            env = etEnv.text.toString().trim(),
            priority = priority, remindBeforeMin = remind, freq = freq,
            weekdays = weekdays, startMD = startMD, endMD = endMD, colorSlot = colorSlot,
            updatedAt = System.currentTimeMillis() + app.prefs.clockSkew,
        )
        app.periodStore.upsert(listOf(t))
        setResult(Activity.RESULT_OK, Intent().putExtra("period", Period.toJson(t).toString()))
        finish()
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
}
