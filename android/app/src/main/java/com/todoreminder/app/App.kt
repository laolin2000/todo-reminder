package com.todoreminder.app

import android.app.Application
import com.todoreminder.app.data.PeriodStore
import com.todoreminder.app.data.Prefs
import com.todoreminder.app.data.SyncClient
import com.todoreminder.app.data.TodoStore
import com.todoreminder.app.notify.Notifier

class App : Application() {
    lateinit var prefs: Prefs
        private set
    lateinit var store: TodoStore
        private set
    lateinit var periodStore: PeriodStore
        private set
    lateinit var sync: SyncClient
        private set

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        store = TodoStore(this)
        periodStore = PeriodStore(this)
        sync = SyncClient(prefs, store, periodStore)
        Notifier.ensureChannel(this)
    }
}
