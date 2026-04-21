package com.nakauri.hrmonitor.session

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.content.Context
import com.nakauri.hrmonitor.ble.BleConnectionState
import com.nakauri.hrmonitor.ble.HrBleManager
import com.nakauri.hrmonitor.ble.HrReading
import com.nakauri.hrmonitor.ble.HrScanner
import com.nakauri.hrmonitor.data.HrPrefs
import com.nakauri.hrmonitor.data.SessionCsvWriter
import com.nakauri.hrmonitor.diag.HrmLog
import com.nakauri.hrmonitor.relay.PresenceEndMessage
import com.nakauri.hrmonitor.relay.PresenceMessage
import com.nakauri.hrmonitor.relay.RelayClient
import com.nakauri.hrmonitor.relay.TickMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * Orchestrates a session: BLE connection, RR/RMSSD accumulation, relay
 * publishing, silent-connection watchdog.
 *
 * Owned by the foreground service. The UI never holds a coordinator; it
 * observes [SessionState] and issues intents.
 */
class SessionCoordinator(
    private val appContext: Context,
    private val prefs: HrPrefs,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val rrWindow = RrWindow()
    private var bleManager: HrBleManager? = null
    private var relay: RelayClient? = null
    private var csv: SessionCsvWriter? = null
    private var sessionStartMs: Long = 0L
    private var senderBooted: Long = 0L
    private var lastTickMs: Long = 0L
    private val senderId = UUID.randomUUID().toString()
    private val senderLabel = "HR Monitor Android"

    fun start(strap: StrapInfo) {
        stop()
        sessionStartMs = System.currentTimeMillis()
        senderBooted = sessionStartMs
        lastTickMs = 0L
        rrWindow.clear()

        csv = try {
            SessionCsvWriter.open(appContext, sessionStartMs)
        } catch (e: Exception) {
            HrmLog.error(TAG, "Could not open session CSV: ${e.message}", e)
            null
        }

        SessionState.setActive(true, sessionStartMs)
        SessionState.setStrap(strap)

        scope.launch {
            val relayKey = prefs.ensureRelayKey()
            relay = RelayClient(
                url = "wss://hr-relay.nakauri.partykit.dev/parties/main/$relayKey",
                senderId = senderId,
                senderLabel = senderLabel,
            ).also { it.start() }
            launchPresenceHeartbeat()
        }

        connectBle(strap)
        launchSilentWatchdog()
    }

    fun stop() {
        relay?.let { r ->
            r.publish(PresenceEndMessage(senderId = senderId))
            r.stop()
        }
        relay = null
        bleManager?.disconnectStrap()
        bleManager?.close()
        bleManager = null
        csv?.close()
        val closedFile = csv?.file
        csv = null
        scope.cancel()
        SessionState.setActive(false)
        rrWindow.clear()
        HrmLog.info(TAG, "Session stopped")
        closedFile?.let { onSessionFileClosed?.invoke(it) }
    }

    /** Hook called with the closed CSV file so the service can enqueue upload. */
    var onSessionFileClosed: ((java.io.File) -> Unit)? = null

    @SuppressLint("MissingPermission")
    private fun connectBle(strap: StrapInfo) {
        val btAdapter = (appContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
            ?: run {
                HrmLog.warn(TAG, "No Bluetooth adapter")
                return
            }
        // Preferred: use the BluetoothDevice handed to us by the scan. Its
        // address type (PUBLIC vs. RANDOM) is already set correctly. Fallback
        // to getRemoteDevice only for restart-from-kill, where we have the
        // MAC from DataStore but no scan cache — those devices usually
        // advertise PUBLIC, and the session wasn't live anyway.
        val device = com.nakauri.hrmonitor.ble.HrScanner.getCachedDevice(strap.mac)
            ?: try { btAdapter.getRemoteDevice(strap.mac) } catch (e: IllegalArgumentException) {
                HrmLog.error(TAG, "Invalid MAC ${strap.mac}", e)
                return
            }
        HrmLog.info(
            TAG,
            "Connecting to ${strap.mac} (cached=${com.nakauri.hrmonitor.ble.HrScanner.getCachedDevice(strap.mac) != null})",
        )

        val manager = HrBleManager(appContext)
        bleManager = manager

        scope.launch {
            var hadReady = false
            var failedAttemptsBeforeReady = 0
            manager.connectionState.collectLatest { state ->
                SessionState.setBleState(state)
                if (state == BleConnectionState.Ready) {
                    hadReady = true
                    failedAttemptsBeforeReady = 0
                }
                if (state == BleConnectionState.Disconnected && SessionState.active.value) {
                    // Fallback-path failure guard. If we never got to Ready and
                    // we've burned INITIAL_CONNECT_ATTEMPTS cycles, the cached
                    // BluetoothDevice almost certainly has the wrong address
                    // type (getRemoteDevice assumed PUBLIC for a RANDOM strap).
                    // Stop the loop and surface a re-pair request — the user
                    // can re-scan to refresh the scan-sourced device handle.
                    if (!hadReady) {
                        failedAttemptsBeforeReady += 1
                        if (failedAttemptsBeforeReady >= INITIAL_CONNECT_ATTEMPTS) {
                            HrmLog.error(
                                TAG,
                                "Gave up after $failedAttemptsBeforeReady connect failures; asking user to re-pair",
                            )
                            SessionState.setPairingStale(true)
                            return@collectLatest
                        }
                    }
                    // After an initial successful link, prefer autoConnect=true
                    // for reconnects: Android holds the connect request and
                    // resumes the instant the strap advertises again. Before
                    // the first success, stay fast so pairing errors surface.
                    HrmLog.warn(TAG, "BLE link lost; reconnecting (auto=${hadReady}, attempt=$failedAttemptsBeforeReady)")
                    delay(1_500)
                    if (SessionState.active.value) manager.connectStrap(device, autoConnect = hadReady)
                }
            }
        }

        scope.launch {
            manager.readings.collectLatest { reading ->
                if (reading != null) onReading(reading)
            }
        }

        scope.launch {
            manager.battery.collectLatest { level ->
                SessionState.setBattery(level)
            }
        }

        scope.launch {
            manager.polarH10.collectLatest { present ->
                SessionState.setPolarH10(present)
                if (present) HrmLog.info(TAG, "Polar H10 detected, ECG stream available")
            }
        }

        scope.launch {
            manager.ecgFrames.collect { frame ->
                SessionState.emitEcg(frame)
            }
        }

        manager.connectStrap(device)
    }

    private fun onReading(reading: HrReading) {
        lastTickMs = System.currentTimeMillis()
        SessionState.markTick(lastTickMs)
        SessionState.setHr(reading.hr)

        val contactOff = reading.contactDetected == false
        SessionState.setContactOff(contactOff)

        if (reading.rrIntervalsMs.isNotEmpty()) {
            rrWindow.addAll(reading.rrIntervalsMs, reading.timestampMs)
        }
        val rmssd = rrWindow.rmssd()
        SessionState.setRmssd(rmssd)

        csv?.appendHrRow(reading.hr, rmssd, reading.timestampMs)

        val elapsedMinutes = ((lastTickMs - sessionStartMs).coerceAtLeast(0L)) / 60_000.0
        val tick = TickMessage(
            senderId = senderId,
            senderLabel = senderLabel,
            senderBooted = senderBooted,
            t = elapsedMinutes,
            hr = reading.hr,
            hrStage = HrStages.hrStage(reading.hr),
            rmssd = rmssd,
            rmssdStage = rmssd?.let { HrStages.rmssdStage(it) },
            palpPerMin = 0.0,
            contactOff = contactOff,
            warn = null,
            conn = "live",
        )
        relay?.publish(tick)
    }

    private fun launchPresenceHeartbeat() {
        scope.launch {
            // Wait until the session is live before sending presence.
            SessionState.active.first { it }
            while (isActive && SessionState.active.value) {
                val state = SessionState.relayState.value
                val connState = when (state) {
                    RelayConnectionState.Live -> "live"
                    RelayConnectionState.Reconnecting, RelayConnectionState.Connecting -> "reconnecting"
                    RelayConnectionState.Offline -> "idle"
                }
                relay?.publish(
                    PresenceMessage(
                        senderId = senderId,
                        senderLabel = senderLabel,
                        startedAt = senderBooted,
                        connState = connState,
                    )
                )
                delay(5_000)
            }
        }
    }

    /**
     * Connected-but-silent detector. BLE says Ready but no HR tick arrived
     * for [SILENT_THRESHOLD_MS] — force a reconnect. Most common real-world
     * failure mode on the Coospo H808S after long idles.
     */
    private fun launchSilentWatchdog() {
        scope.launch {
            while (isActive && SessionState.active.value) {
                delay(SILENT_POLL_MS)
                val bleReady = SessionState.bleState.value == BleConnectionState.Ready
                val lastTick = SessionState.lastTickMs.value ?: 0L
                val silentFor = System.currentTimeMillis() - lastTick
                if (bleReady && lastTick > 0L && silentFor > SILENT_THRESHOLD_MS) {
                    HrmLog.warn(TAG, "Silent BLE link for ${silentFor}ms, forcing reconnect")
                    val strap = SessionState.strap.value ?: continue
                    bleManager?.disconnectStrap()
                    delay(500)
                    // Reset lastTick so the watchdog doesn't re-fire before
                    // the reconnect has had a chance to deliver a first tick.
                    SessionState.markTick(System.currentTimeMillis())
                    connectBle(strap)
                }
            }
        }
    }

    companion object {
        private const val TAG = "session"
        private const val SILENT_POLL_MS = 5_000L
        private const val SILENT_THRESHOLD_MS = 30_000L
        private const val INITIAL_CONNECT_ATTEMPTS = 4
    }
}

/** Convenience: try to resume the last-known strap from DataStore. */
suspend fun HrPrefs.lastStrap(): StrapInfo? {
    val current = state.first()
    val mac = current.lastStrapMac ?: return null
    return StrapInfo(mac = mac, name = current.lastStrapName)
}

/** Stop scanning if a scan is running. BLE connect after scan-stop. */
@SuppressLint("MissingPermission")
fun stopAnyScan(context: Context) {
    if (HrScanner.scanning.value) HrScanner.stop(context)
}
