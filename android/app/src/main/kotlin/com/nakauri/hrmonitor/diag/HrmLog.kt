package com.nakauri.hrmonitor.diag

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentLinkedDeque

/**
 * Ring-buffer event log. Any subsystem (BLE, WebSocket, service lifecycle)
 * calls HrmLog.info/warn/error with a short message. UI subscribes to
 * [events] to render the diagnostics-screen event list.
 *
 * Caps at MAX_ENTRIES. Oldest drop first.
 */
object HrmLog {
    private const val MAX_ENTRIES = 200
    private const val LOG_TAG = "HRMonitor"

    private val buffer = ConcurrentLinkedDeque<Entry>()
    private val _events = MutableStateFlow<List<Entry>>(emptyList())
    val events: StateFlow<List<Entry>> = _events.asStateFlow()

    fun info(tag: String, message: String) = push(Level.Info, tag, message).also {
        Log.i("$LOG_TAG/$tag", message)
    }

    fun warn(tag: String, message: String) = push(Level.Warn, tag, message).also {
        Log.w("$LOG_TAG/$tag", message)
    }

    fun error(tag: String, message: String, throwable: Throwable? = null) =
        push(Level.Error, tag, message).also {
            Log.e("$LOG_TAG/$tag", message, throwable)
        }

    fun clear() {
        buffer.clear()
        _events.value = emptyList()
    }

    fun dumpText(): String {
        val fmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
        return buffer.joinToString("\n") { e ->
            "${fmt.format(Date(e.timestamp))} [${e.level.name.uppercase()}] ${e.tag}: ${e.message}"
        }
    }

    private fun push(level: Level, tag: String, message: String) {
        buffer.addLast(Entry(System.currentTimeMillis(), level, tag, message))
        while (buffer.size > MAX_ENTRIES) buffer.pollFirst()
        _events.value = buffer.toList()
    }

    enum class Level { Info, Warn, Error }

    data class Entry(
        val timestamp: Long,
        val level: Level,
        val tag: String,
        val message: String,
    )
}
