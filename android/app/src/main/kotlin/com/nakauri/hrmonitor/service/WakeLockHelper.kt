package com.nakauri.hrmonitor.service

import android.content.Context
import android.os.PowerManager

/**
 * PARTIAL_WAKE_LOCK around the foreground-service lifetime. FGS alone does
 * not keep CPU awake under Doze; a wake lock held by the service does.
 *
 * Non-reference-counted: one acquire pairs with one release regardless of
 * how many times acquire() is called.
 */
object WakeLockHelper {
    private const val LOCK_TAG = "HRMonitor:FGS"
    private var wakeLock: PowerManager.WakeLock? = null

    @Synchronized
    fun acquire(context: Context): Boolean {
        wakeLock?.takeIf { it.isHeld }?.let { return true }
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        val lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, LOCK_TAG).apply {
            setReferenceCounted(false)
            acquire()
        }
        wakeLock = lock
        return lock.isHeld
    }

    @Synchronized
    fun release() {
        wakeLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
    }

    @Synchronized
    fun isHeld(): Boolean = wakeLock?.isHeld == true
}
