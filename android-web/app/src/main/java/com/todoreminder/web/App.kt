package com.todoreminder.web

import android.app.Application
import com.todoreminder.web.data.PeriodStore
import com.todoreminder.web.data.Prefs
import com.todoreminder.web.data.TodoStore
import com.todoreminder.web.notify.Notifier

/**
 * 一体包应用: 手机本地为数据主本(store/periodStore),
 * Web UI 通过本地服务器读写; 原生层负责通知与闹钟调度。
 */
class App : Application() {
    lateinit var prefs: Prefs
        private set
    lateinit var store: TodoStore
        private set
    lateinit var periodStore: PeriodStore
        private set

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        store = TodoStore(this)
        periodStore = PeriodStore(this)
        Notifier.ensureChannel(this)
    }
}
