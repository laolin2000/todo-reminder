package com.todoreminder.app.ui

import android.graphics.Paint
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.CheckBox
import android.widget.ImageButton
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.RecyclerView
import com.todoreminder.app.R
import com.todoreminder.app.data.Todo
import com.todoreminder.app.util.Fmt

/** 列表适配器: 分组头 + 待办卡片 */
class TodoAdapter(private val listener: Listener) :
    RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    interface Listener {
        fun onToggle(t: Todo)
        fun onClick(t: Todo)
        fun onMenu(t: Todo, anchor: View)
        fun onHeaderTap(collapseKey: String)
    }

    private var items: List<Any> = emptyList()
    private var nowMs: Long = System.currentTimeMillis()

    fun submit(list: List<Any>, now: Long) {
        items = list
        nowMs = now
        notifyDataSetChanged()
    }

    override fun getItemCount() = items.size

    override fun getItemViewType(position: Int) = if (items[position] is String) 0 else 1

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        return if (viewType == 0) HeaderVH(inflater.inflate(R.layout.item_group, parent, false))
        else TodoVH(inflater.inflate(R.layout.item_todo, parent, false))
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        val it = items[position]
        if (holder is HeaderVH && it is String && it.startsWith("H|")) {
            val parts = it.split("|", limit = 4)
            holder.label.text = "${parts[2]}  ${parts.getOrElse(3) { "" }}"
            holder.itemView.setOnClickListener { listener.onHeaderTap(parts[1]) }
        } else if (holder is TodoVH && it is Todo) {
            holder.bind(it)
        }
    }

    inner class HeaderVH(view: View) : RecyclerView.ViewHolder(view) {
        val label: TextView = view.findViewById(R.id.tvGroupLabel)
    }

    inner class TodoVH(view: View) : RecyclerView.ViewHolder(view) {
        private val check: CheckBox = view.findViewById(R.id.chkDone)
        private val title: TextView = view.findViewById(R.id.tvTitle)
        private val time: TextView = view.findViewById(R.id.tvTime)
        private val desc: TextView = view.findViewById(R.id.tvDesc)
        private val statusTag: TextView = view.findViewById(R.id.tvTag)
        private val btnMenu: ImageButton = view.findViewById(R.id.btnMenu)
        private val vColor: View = view.findViewById(R.id.viewColor)

        fun bind(t: Todo) {
            val ctx = itemView.context
            title.text = t.title
            title.paintFlags = if (t.isDone) title.paintFlags or Paint.STRIKE_THRU_TEXT_FLAG
            else title.paintFlags and Paint.STRIKE_THRU_TEXT_FLAG.inv()
            itemView.alpha = if (t.isDone) 0.6f else 1f

            check.isChecked = t.isDone
            check.setOnClickListener { listener.onToggle(t) }
            itemView.setOnClickListener { listener.onClick(t) }
            btnMenu.setOnClickListener { listener.onMenu(t, btnMenu) }

            // 状态小标签(派生: 到开始→进行中; 过结束→已逾期; 已完成不再列入逾期)
            val life = Fmt.life(t, nowMs)
            if (t.isDone) {
                statusTag.visibility = View.VISIBLE
                statusTag.text = "已完成"
                statusTag.setBackgroundResource(R.drawable.bg_tag_done)
                statusTag.setTextColor(ContextCompat.getColor(ctx, R.color.ok))
            } else when (life) {
                "doing" -> {
                    statusTag.visibility = View.VISIBLE
                    statusTag.text = "进行中"
                    statusTag.setBackgroundResource(R.drawable.bg_tag_warn)
                    statusTag.setTextColor(ContextCompat.getColor(ctx, R.color.warn))
                }
                "overdue" -> {
                    statusTag.visibility = View.VISIBLE
                    statusTag.text = "已逾期"
                    statusTag.setBackgroundResource(R.drawable.bg_tag_bad)
                    statusTag.setTextColor(ContextCompat.getColor(ctx, R.color.bad))
                }
                else -> statusTag.visibility = View.GONE
            }

            // 时间行: 剩余/已超文案; 逾期红、进行中橙
            time.visibility = View.VISIBLE
            if (t.dueAt != null) {
                val base = Fmt.dueText(t, nowMs)
                time.text = if (t.isDone) base else "$base  (${Fmt.lifeText(t, nowMs)})"
                time.setTextColor(
                    ContextCompat.getColor(
                        ctx,
                        when (life) {
                            "overdue" -> R.color.bad
                            "doing" -> R.color.warn
                            else -> R.color.ink2
                        },
                    ),
                )
            } else {
                time.text = if (t.isDone) "" else "未定时间"
                time.setTextColor(ContextCompat.getColor(ctx, R.color.ink3))
            }
            if (t.isDone && t.dueAt == null) time.visibility = View.GONE

            // 描述行: 模糊/重复/地点/重要/时长/材料/依赖
            val parts = mutableListOf<String>()
            if (t.fuzzy) parts += "🌫模糊(不提醒)"
            if (t.repeat != "none") parts += "🔁" + Fmt.repeatCn(t)
            if (t.location.isNotBlank()) parts += "📍${t.location}"
            parts += Fmt.impText(t)
            Fmt.duration(t.durationMin).takeIf { it.isNotBlank() }?.let { parts += "⏱$it" }
            if (t.materials.isNotEmpty()) parts += "🧰" + t.materials.take(3).joinToString("、") +
                (if (t.materials.size > 3) "…" else "")
            if (!t.independent) parts += "🔗依赖"
            desc.text = parts.joinToString(" · ")
            desc.visibility = if (parts.isEmpty()) View.GONE else View.VISIBLE

            // 重要程度左侧色条: 高红 / 低灰 / 中不标
            vColor.setBackgroundColor(
                ContextCompat.getColor(
                    ctx,
                    when (t.importance) { 2 -> R.color.imp_high; 0 -> R.color.imp_low; else -> android.R.color.transparent },
                ),
            )
        }
    }
}
