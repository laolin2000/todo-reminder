package com.todoreminder.app.util

/** 与电脑端 web/js/model.js 的 9 槽色板保持一致(时段泳道颜色) */
object Palette {
    // 槽 0-2 高优先(玫红/珊瑚/杏), 3-5 中(薄荷/青/湖蓝), 6-8 低(雾蓝/藕紫/灰紫)
    val DEEP = arrayOf("#c52b45", "#c5592b", "#c5972b", "#2bc57d", "#2bc5b5", "#2b9cc5", "#2b59c5", "#452bc5", "#732bc5")
    val BASE = arrayOf("#e79da9", "#e7b39d", "#e7d09d", "#9de7c4", "#9de7df", "#9dd3e7", "#9db3e7", "#a99de7", "#bf9de7")
    val NONE_DEEP = "#87909f"

    fun groupStart(priority: Int): Int = when (priority) {
        2 -> 0
        1 -> 3
        else -> 6
    }

    /** 时段显示色槽: 已存槽直接用, 否则组内第一空闲(近似), 供显示 */
    fun effectiveSlot(priority: Int, slot: Int?, occupied: Set<Int>): Int {
        if (slot != null) return slot
        val start = groupStart(priority)
        for (i in start until start + 3) if (!occupied.contains(i)) return i
        return start
    }
}
