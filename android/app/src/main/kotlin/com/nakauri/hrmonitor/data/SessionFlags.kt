package com.nakauri.hrmonitor.data

import android.content.Context

/**
 * Synchronous boolean flag survived through process kill. Held in
 * SharedPreferences rather than DataStore so the write can complete inline
 * with [commit] — the service uses this to decide whether a null-intent
 * START_STICKY restart should resume the last session or shut down.
 *
 * DataStore is async; a kill between the async write and the flush would
 * race with the service respawn and falsely resume a stopped session.
 */
object SessionFlags {
    private const val FILE = "session_flags"
    private const val KEY_INTENDED = "session_intended"

    fun setIntended(context: Context, intended: Boolean) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_INTENDED, intended)
            .commit()
    }

    fun isIntended(context: Context): Boolean =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            .getBoolean(KEY_INTENDED, false)
}
