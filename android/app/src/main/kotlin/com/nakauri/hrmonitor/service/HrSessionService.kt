package com.nakauri.hrmonitor.service

import android.app.Notification
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.nakauri.hrmonitor.HrMonitorApp
import com.nakauri.hrmonitor.MainActivity
import com.nakauri.hrmonitor.R
import com.nakauri.hrmonitor.data.HrPrefs
import com.nakauri.hrmonitor.data.SessionFlags
import com.nakauri.hrmonitor.diag.HrmLog
import com.nakauri.hrmonitor.session.SessionCoordinator
import com.nakauri.hrmonitor.session.SessionState
import com.nakauri.hrmonitor.session.StrapInfo
import com.nakauri.hrmonitor.session.lastStrap
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Foreground service hosting the active session. Owns the
 * [SessionCoordinator] and updates the ongoing notification with live HR.
 *
 * Intents:
 *   ACTION_START_SESSION — start or resume a session. Reads the last-known
 *     strap MAC from DataStore if no mac is supplied.
 *   ACTION_STOP_SESSION — tear down and stop the service.
 *
 * START_STICKY on restart-from-kill: re-resolves the last strap and
 * reconnects so the session survives transient OOM kills.
 */
class HrSessionService : LifecycleService() {

    private lateinit var prefs: HrPrefs
    private var coordinator: SessionCoordinator? = null
    private var notificationJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        prefs = HrPrefs(applicationContext)
        startForegroundNotification(hr = null)
        WakeLockHelper.acquire(this)
        launchNotificationUpdater()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        val action = intent?.action
        val mac = intent?.getStringExtra(EXTRA_STRAP_MAC)
        val name = intent?.getStringExtra(EXTRA_STRAP_NAME)

        when (action) {
            ACTION_STOP_SESSION -> {
                HrmLog.info(TAG, "Stop requested via intent")
                SessionFlags.setIntended(applicationContext, false)
                stopSessionAndSelf()
                return START_NOT_STICKY
            }
            ACTION_START_SESSION -> {
                if (mac != null) {
                    SessionFlags.setIntended(applicationContext, true)
                    startSession(StrapInfo(mac, name))
                }
            }
            null -> {
                // START_STICKY restart after process kill. Only resume if the
                // user had an active session when the process died.
                if (!SessionFlags.isIntended(applicationContext)) {
                    HrmLog.info(TAG, "Restart with no intended session; stopping")
                    stopSessionAndSelf()
                    return START_NOT_STICKY
                }
                lifecycleScope.launch {
                    val last = prefs.lastStrap()
                    if (last != null) {
                        HrmLog.info(TAG, "Resuming last strap ${last.mac}")
                        startSession(last)
                    } else {
                        HrmLog.warn(TAG, "Intended session but no strap; stopping")
                        SessionFlags.setIntended(applicationContext, false)
                        stopSessionAndSelf()
                    }
                }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        notificationJob?.cancel()
        coordinator?.stop()
        coordinator = null
        WakeLockHelper.release()
        super.onDestroy()
    }

    override fun onBind(intent: Intent): IBinder? {
        super.onBind(intent)
        return null
    }

    private fun startSession(strap: StrapInfo) {
        val existing = coordinator
        if (existing != null && SessionState.active.value && SessionState.strap.value?.mac == strap.mac) {
            HrmLog.info(TAG, "Session already running for ${strap.mac}")
            return
        }
        existing?.stop()
        val c = SessionCoordinator(applicationContext, prefs)
        coordinator = c
        c.start(strap)
    }

    private fun stopSessionAndSelf() {
        coordinator?.stop()
        coordinator = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun launchNotificationUpdater() {
        notificationJob = lifecycleScope.launch {
            combine(
                SessionState.hr,
                SessionState.relayState,
                SessionState.bleState,
            ) { hr, relay, ble ->
                Triple(hr, relay, ble)
            }.collect { (hr, _, _) ->
                updateNotification(hr)
            }
        }
    }

    private fun startForegroundNotification(hr: Int?) {
        val notification = buildNotification(hr)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification(hr: Int?) {
        val nm = getSystemService(android.app.NotificationManager::class.java) ?: return
        nm.notify(NOTIFICATION_ID, buildNotification(hr))
    }

    private fun buildNotification(hr: Int?): Notification {
        val contentIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pending = PendingIntent.getActivity(
            this,
            0,
            contentIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val stopIntent = Intent(this, HrSessionService::class.java).apply {
            action = ACTION_STOP_SESSION
        }
        val stopPending = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val bodyText = when {
            hr != null -> "HR ${hr} bpm"
            SessionState.bleState.value.name == "Ready" -> "Connected, waiting for HR"
            SessionState.bleState.value.name == "Connecting" -> "Connecting to strap"
            else -> getString(R.string.session_notification_text_idle)
        }

        return NotificationCompat.Builder(this, HrMonitorApp.SESSION_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_hr)
            .setContentTitle(getString(R.string.session_notification_title))
            .setContentText(bodyText)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(pending)
            .addAction(0, "Stop", stopPending)
            .build()
    }

    companion object {
        const val NOTIFICATION_ID = 1001
        const val ACTION_START_SESSION = "com.nakauri.hrmonitor.action.START_SESSION"
        const val ACTION_STOP_SESSION = "com.nakauri.hrmonitor.action.STOP_SESSION"
        const val EXTRA_STRAP_MAC = "strap_mac"
        const val EXTRA_STRAP_NAME = "strap_name"
        private const val TAG = "service"
    }
}
