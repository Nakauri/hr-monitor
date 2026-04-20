package com.nakauri.hrmonitor.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.nakauri.hrmonitor.data.HrPrefs
import com.nakauri.hrmonitor.data.HrPrefsState
import com.nakauri.hrmonitor.diag.HrmLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * Single app-scoped ViewModel. Holds nav route, live HR snapshot (fed by
 * the service once BLE lands in Phase 2), prefs state.
 *
 * Phase 1 keeps this minimal: route state is saveable, prefs are pulled
 * from DataStore, live values are placeholders until BLE + WebSocket wire
 * in.
 */
class AppViewModel(app: Application) : AndroidViewModel(app) {

    private val prefs = HrPrefs(app)

    val prefsState: StateFlow<HrPrefsState> = prefs.state.stateIn(
        scope = viewModelScope,
        started = SharingStarted.Eagerly,
        initialValue = HrPrefsState(),
    )

    private val _route = MutableStateFlow<AppRoute>(AppRoute.Scan)
    val route: StateFlow<AppRoute> = _route.asStateFlow()

    private val _sessionActive = MutableStateFlow(false)
    val sessionActive: StateFlow<Boolean> = _sessionActive.asStateFlow()

    private val _liveHr = MutableStateFlow<Int?>(null)
    val liveHr: StateFlow<Int?> = _liveHr.asStateFlow()

    private val _liveRmssd = MutableStateFlow<Double?>(null)
    val liveRmssd: StateFlow<Double?> = _liveRmssd.asStateFlow()

    init {
        viewModelScope.launch {
            val key = prefs.ensureRelayKey()
            HrmLog.info("vm", "Relay key ready (${key.take(4)}...)")
        }
    }

    fun navigate(route: AppRoute) {
        _route.value = route
    }

    fun startSession() {
        _sessionActive.value = true
        HrmLog.info("session", "Session start requested")
        _route.value = AppRoute.Live
    }

    fun stopSession() {
        _sessionActive.value = false
        _liveHr.value = null
        _liveRmssd.value = null
        HrmLog.info("session", "Session stopped")
        _route.value = AppRoute.Scan
    }

    fun rememberStrap(mac: String, name: String?) {
        viewModelScope.launch {
            prefs.setLastStrap(mac, name)
            HrmLog.info("strap", "Remembered $mac (${name ?: "unnamed"})")
        }
    }

    fun forgetStrap() {
        viewModelScope.launch {
            prefs.clearLastStrap()
            HrmLog.info("strap", "Forgot last strap")
        }
    }

    fun regenerateRelayKey() {
        viewModelScope.launch {
            val key = prefs.regenerateRelayKey()
            HrmLog.info("relay", "Regenerated relay key (${key.take(4)}...)")
        }
    }

    fun setBootRestartEnabled(enabled: Boolean) {
        viewModelScope.launch { prefs.setBootRestartEnabled(enabled) }
    }
}

sealed interface AppRoute {
    data object Scan : AppRoute
    data object Live : AppRoute
    data object Diagnostics : AppRoute
}
