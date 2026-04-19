package com.nakauri.hrmonitor.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Restart the session service after reboot or app upgrade, gated by a user
 * opt-in stored in DataStore. Phase 0 just declares the receiver; the
 * opt-in gate and service start land in Phase 4 alongside watchdog alarms.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // No-op for Phase 0. Manifest registration reserves the receiver so
        // the Phase 4 wiring is drop-in without a manifest change.
    }
}
