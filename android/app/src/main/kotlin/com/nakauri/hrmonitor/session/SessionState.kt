package com.nakauri.hrmonitor.session

import com.nakauri.hrmonitor.ble.BleConnectionState
import com.nakauri.hrmonitor.ble.polar.EcgFrameParser
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
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

    /**
     * True when the coordinator has exhausted reconnect attempts against a
     * cached or fallback BluetoothDevice (usually because the stored device
     * handle has the wrong address type after a restart-from-kill). UI
     * surfaces a "re-pair" banner when this is true.
     */
    private val _pairingStale = MutableStateFlow(false)
    val pairingStale: StateFlow<Boolean> = _pairingStale.asStateFlow()

    /** True when the connected strap exposed the Polar PMD service (H10). */
    private val _polarH10 = MutableStateFlow(false)
    val polarH10: StateFlow<Boolean> = _polarH10.asStateFlow()

    /**
     * Rolling window of the last ~45 seconds of HR samples, one entry per
     * BLE tick. Format: [timestampMs, hrBpm]. The Live widget's inline
     * trace reads this to draw the scrolling line that mirrors the
     * desktop overlay's live HR trace.
     */
    data class HrPoint(val timestampMs: Long, val hrBpm: Int)
    private val _hrSeries = MutableStateFlow<List<HrPoint>>(emptyList())
    val hrSeries: StateFlow<List<HrPoint>> = _hrSeries.asStateFlow()
    private const val HR_SERIES_WINDOW_MS: Long = 45_000L

    fun appendHrPoint(point: HrPoint) {
        val current = _hrSeries.value
        val cutoff = point.timestampMs - HR_SERIES_WINDOW_MS
        val pruned = current.dropWhile { it.timestampMs < cutoff }
        _hrSeries.value = pruned + point
    }

    /**
     * Raw ECG frames from the Polar PMD stream, 130 Hz on the H10. Empty
     * when the connected strap isn't an H10. Consumers (UI trace, CSV
     * writer) observe and keep their own rolling buffers.
     */
    private val _ecgFrames = MutableSharedFlow<EcgFrameParser.EcgFrame>(
        extraBufferCapacity = 32,
    )
    val ecgFrames: SharedFlow<EcgFrameParser.EcgFrame> = _ecgFrames.asSharedFlow()

    fun setActive(active: Boolean, startMs: Long? = null) {
        _active.value = active
        _sessionStartMs.value = if (active) (startMs ?: System.currentTimeMillis()) else null
        if (active) {
            _pairingStale.value = false
        }
        if (!active) {
            _hr.value = null
            _rmssd.value = null
            _battery.value = null
            _contactOff.value = false
            _bleState.value = BleConnectionState.Disconnected
            _relayState.value = RelayConnectionState.Offline
            _lastTickMs.value = null
            _polarH10.value = false
            _hrSeries.value = emptyList()
        }
    }

    fun setPairingStale(stale: Boolean) { _pairingStale.value = stale }

    fun setStrap(info: StrapInfo?) { _strap.value = info }
    fun setBleState(state: BleConnectionState) { _bleState.value = state }
    fun setHr(hr: Int?) { _hr.value = hr }
    fun setRmssd(rmssd: Double?) { _rmssd.value = rmssd }
    fun setBattery(level: Int?) { _battery.value = level }
    fun setContactOff(off: Boolean) { _contactOff.value = off }
    fun setRelayState(state: RelayConnectionState) { _relayState.value = state }
    fun setPolarH10(present: Boolean) { _polarH10.value = present }
    fun emitEcg(frame: EcgFrameParser.EcgFrame) { _ecgFrames.tryEmit(frame) }
    fun markTick(ms: Long = System.currentTimeMillis()) { _lastTickMs.value = ms }
}

data class StrapInfo(val mac: String, val name: String?)

enum class RelayConnectionState { Offline, Connecting, Live, Reconnecting }
