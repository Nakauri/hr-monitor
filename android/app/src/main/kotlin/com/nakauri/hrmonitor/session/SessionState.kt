package com.nakauri.hrmonitor.session

import com.nakauri.hrmonitor.ble.BleConnectionState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Process-wide state shared between the foreground service (producer) and
 * the UI (consumer). Keeping this as a singleton lets Composables subscribe
 * without a bound-service handshake or an extra StateFlow layer.
 *
 * The service updates; anyone can observe.
 */
object SessionState {

    private val _active = MutableStateFlow(false)
    val active: StateFlow<Boolean> = _active.asStateFlow()

    private val _strap = MutableStateFlow<StrapInfo?>(null)
    val strap: StateFlow<StrapInfo?> = _strap.asStateFlow()

    private val _bleState = MutableStateFlow(BleConnectionState.Disconnected)
    val bleState: StateFlow<BleConnectionState> = _bleState.asStateFlow()

    private val _hr = MutableStateFlow<Int?>(null)
    val hr: StateFlow<Int?> = _hr.asStateFlow()

    private val _rmssd = MutableStateFlow<Double?>(null)
    val rmssd: StateFlow<Double?> = _rmssd.asStateFlow()

    private val _battery = MutableStateFlow<Int?>(null)
    val battery: StateFlow<Int?> = _battery.asStateFlow()

    private val _contactOff = MutableStateFlow(false)
    val contactOff: StateFlow<Boolean> = _contactOff.asStateFlow()

    private val _relayState = MutableStateFlow(RelayConnectionState.Offline)
    val relayState: StateFlow<RelayConnectionState> = _relayState.asStateFlow()

    private val _sessionStartMs = MutableStateFlow<Long?>(null)
    val sessionStartMs: StateFlow<Long?> = _sessionStartMs.asStateFlow()

    private val _lastTickMs = MutableStateFlow<Long?>(null)
    val lastTickMs: StateFlow<Long?> = _lastTickMs.asStateFlow()

    fun setActive(active: Boolean, startMs: Long? = null) {
        _active.value = active
        _sessionStartMs.value = if (active) (startMs ?: System.currentTimeMillis()) else null
        if (!active) {
            _hr.value = null
            _rmssd.value = null
            _battery.value = null
            _contactOff.value = false
            _bleState.value = BleConnectionState.Disconnected
            _relayState.value = RelayConnectionState.Offline
            _lastTickMs.value = null
        }
    }

    fun setStrap(info: StrapInfo?) { _strap.value = info }
    fun setBleState(state: BleConnectionState) { _bleState.value = state }
    fun setHr(hr: Int?) { _hr.value = hr }
    fun setRmssd(rmssd: Double?) { _rmssd.value = rmssd }
    fun setBattery(level: Int?) { _battery.value = level }
    fun setContactOff(off: Boolean) { _contactOff.value = off }
    fun setRelayState(state: RelayConnectionState) { _relayState.value = state }
    fun markTick(ms: Long = System.currentTimeMillis()) { _lastTickMs.value = ms }
}

data class StrapInfo(val mac: String, val name: String?)

enum class RelayConnectionState { Offline, Connecting, Live, Reconnecting }
