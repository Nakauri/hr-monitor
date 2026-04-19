package com.nakauri.hrmonitor

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import io.sentry.android.core.SentryAndroid

class HrMonitorApp : Application() {

    override fun onCreate() {
        super.onCreate()
        initSentry()
        createSessionChannel()
    }

    private fun initSentry() {
        val dsn = BuildConfig.SENTRY_DSN
        if (dsn.isBlank()) return
        SentryAndroid.init(this) { options ->
            options.dsn = dsn
            options.isAnrEnabled = true
            options.anrTimeoutIntervalMillis = 5_000
            options.environment = if (BuildConfig.DEBUG) "debug" else "release"
            options.release = BuildConfig.VERSION_NAME
            options.beforeBreadcrumb = io.sentry.SentryOptions.BeforeBreadcrumbCallback { b, _ -> b }
        }
    }

    private fun createSessionChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            SESSION_CHANNEL_ID,
            getString(R.string.session_channel_name),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.session_channel_description)
            setShowBadge(false)
            setSound(null, null)
            enableVibration(false)
        }
        nm.createNotificationChannel(channel)
    }

    companion object {
        const val SESSION_CHANNEL_ID = "hr_session"
    }
}
