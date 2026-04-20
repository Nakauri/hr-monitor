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
 * App-scoped ViewModel. Holds nav route and pending-start intent.
 * Live HR / RMSSD / connection state live in [com.nakauri.hrmonitor.session.SessionState]
 * (updated by the service) and are observed directly by Composables.
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

    private val _pendingStart = MutableStateFlow<PendingStart?>(null)
    val pendingStart: StateFlow<PendingStart?> = _pendingStart.asStateFlow()

    private val _pendingStop = MutableStateFlow(false)
    val pendingStop: StateFlow<Boolean> = _pendingStop.asStateFlow()

    init {
        viewModelScope.launch {
            val key = prefs.ensureRelayKey()
            HrmLog.info("vm", "Relay key ready (${key.take(4)}...)")
        }
    }

    fun navigate(route: AppRoute) {
        _route.value = route
    }

    fun requestStartSession(mac: String, name: String?) {
        _pendingStart.value = PendingStart(mac, name)
        _route.value = AppRoute.Live
    }

    fun consumePendingStart(): PendingStart? {
        val p = _pendingStart.value
        _pendingStart.value = null
        return p
    }

    fun requestStopSession() {
        _pendingStop.value = true
        _route.value = AppRoute.Scan
    }

    fun consumePendingStop(): Boolean {
        val v = _pendingStop.value
        _pendingStop.value = false
        return v
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

data class PendingStart(val mac: String, val name: String?)
