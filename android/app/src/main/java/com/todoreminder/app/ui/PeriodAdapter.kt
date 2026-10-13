package com.todoreminder.app.ui

import android.graphics.Color
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.TextView
import androidx.core.graphics.ColorUtils
import androidx.recyclerview.widget.RecyclerView
import com.todoreminder.app.R
import com.todoreminder.app.data.Period
import com.todoreminder.app.data.freqLabel
import com.todoreminder.app.data.fmtMin
import com.todoreminder.app.util.Fmt
import com.todoreminder.app.util.Palette

/** 时段库列表 */
class PeriodAdapter(
    private val periods: List<Period>,
    private val onEdit: (Period) -> Unit,
    private val onDelete: (Period) -> Unit,
) : RecyclerView.Adapter<PeriodAdapter.VH>() {

    private val occupied: Set<Int> =
        periods.filter { it.colorSlot != null }.mapNotNull { it.colorSlot }.toSet()

    class VH(view: View) : RecyclerView.ViewHolder(view) {
        val vColor: View = view.findViewById(R.id.vColor)
        val pill: View = view.findViewById(R.id.pill)
        val name: TextView = view.findViewById(R.id.tvName)
        val time: TextView = view.findViewById(R.id.tvTime)
        val meta: TextView = view.findViewById(R.id.tvMeta)
        val pri: TextView = view.findViewById(R.id.tvPri)
        val btn: ImageButton = view.findViewById(R.id.btnEdit)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH =
        VH(LayoutInflater.from(parent.context).inflate(R.layout.item_period, parent, false))

    override fun getItemCount() = periods.size

    override fun onBindViewHolder(h: VH, position: Int) {
        val p = periods[position]
        val slot = Palette.effectiveSlot(p.priority, p.colorSlot, occupied)
        val deep = Palette.DEEP[slot]
        val base = Palette.BASE[slot]
        try {
            h.vColor.setBackgroundColor(Color.parseColor(deep))
            h.pill.setBackgroundColor(Color.parseColor(deep))
        } catch (e: Exception) { /* ignore */ }
        h.name.text = p.name
        h.time.text = "⏱ ${fmtMin(p.startMin)}–${fmtMin(p.endMin)} · 🔁 ${freqLabel(p)}"
        val parts = mutableListOf<String>()
        if (p.idleName.isNotBlank() && p.idleName != p.name) parts += "💤 空闲名: ${p.idleName}"
        if (p.env.isNotBlank()) parts += "🌿 ${p.env}"
        if (p.remindBeforeMin > 0) parts += "🔔 提前${p.remindBeforeMin}分" else parts += "🔔 不提醒"
        h.meta.text = parts.joinToString(" · ")
        h.pri.text = "⭐ " + Fmt.impLabels.getOrElse(p.priority) { "中" }
        try {
            h.pri.setBackgroundColor(Color.parseColor(base))
            h.pri.setTextColor(Color.parseColor("#23272f"))
        } catch (e: Exception) { /* ignore */ }
        h.itemView.setOnClickListener { onEdit(p) }
        h.btn.setOnClickListener { v ->
            val pm = android.widget.PopupMenu(v.context, v)
            pm.menu.add(0, 1, 0, "编辑")
            pm.menu.add(0, 2, 1, "删除")
            pm.setOnMenuItemClickListener { mi ->
                when (mi.itemId) {
                    1 -> onEdit(p)
                    2 -> onDelete(p)
                }
                true
            }
            pm.show()
        }
    }
}
