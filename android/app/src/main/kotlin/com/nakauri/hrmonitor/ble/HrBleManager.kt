package com.nakauri.hrmonitor.ble

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.content.Context
import com.nakauri.hrmonitor.ble.polar.EcgFrameParser
import com.nakauri.hrmonitor.ble.polar.PmdControlResponse
import com.nakauri.hrmonitor.ble.polar.PolarPmdCommands
import com.nakauri.hrmonitor.ble.polar.PolarPmdSpec
import com.nakauri.hrmonitor.diag.HrmLog
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import no.nordicsemi.android.ble.BleManager
import no.nordicsemi.android.ble.observer.ConnectionObserver

/**
 * BleManager subclass covering:
 *   - Standard HR service (0x180D / 0x2A37) — every strap.
 *   - Battery service (0x180F / 0x2A19) — most straps.
 *   - Polar PMD service (FB005C80-...) for raw ECG streaming — Polar H10 only.
 *
 * PMD is additive: if the strap doesn't expose the PMD service (Coospo, Wahoo,
 * older H10 firmware <3.0), we fall through to HR-only. When PMD is present,
 * we enable the CP and DATA characteristics' notifications, wait the required
 * ~300 ms settling window, then write the START_H10_ECG command. Frames
 * arrive at 130 Hz and surface via [ecgFrames].
 */
class HrBleManager(context: Context) : BleManager(context) {

    private var hrCharacteristic: BluetoothGattCharacteristic? = null
    private var batteryCharacteristic: BluetoothGattCharacteristic? = null
    private var pmdControlCharacteristic: BluetoothGattCharacteristic? = null
    private var pmdDataCharacteristic: BluetoothGattCharacteristic? = null

    private val _readings = MutableStateFlow<HrReading?>(null)
    val readings: StateFlow<HrReading?> = _readings.asStateFlow()

    private val _battery = MutableStateFlow<Int?>(null)
    val battery: StateFlow<Int?> = _battery.asStateFlow()

    private val _connectionState = MutableStateFlow(BleConnectionState.Disconnected)
    val connectionState: StateFlow<BleConnectionState> = _connectionState.asStateFlow()

    /** True once this device has been detected as a Polar H10 (PMD present). */
    private val _polarH10 = MutableStateFlow(false)
    val polarH10: StateFlow<Boolean> = _polarH10.asStateFlow()

    /** Raw ECG frames. Empty when the strap is not a Polar H10. */
    private val _ecgFrames = MutableSharedFlow<EcgFrameParser.EcgFrame>(
        extraBufferCapacity = 32,
    )
    val ecgFrames: SharedFlow<EcgFrameParser.EcgFrame> = _ecgFrames.asSharedFlow()

    init {
        setConnectionObserver(object : ConnectionObserver {
            override fun onDeviceConnecting(device: BluetoothDevice) {
                HrmLog.info(TAG, "Connecting to ${device.address}")
                _connectionState.value = BleConnectionState.Connecting
            }
            override fun onDeviceConnected(device: BluetoothDevice) {
                HrmLog.info(TAG, "GATT connected ${device.address}")
            }
            override fun onDeviceFailedToConnect(device: BluetoothDevice, reason: Int) {
                HrmLog.warn(TAG, "Failed to connect ${device.address} reason=$reason")
                _connectionState.value = BleConnectionState.Disconnected
            }
            override fun onDeviceReady(device: BluetoothDevice) {
                HrmLog.info(TAG, "Services ready ${device.address}")
                _connectionState.value = BleConnectionState.Ready
            }
            override fun onDeviceDisconnecting(device: BluetoothDevice) {
                _connectionState.value = BleConnectionState.Disconnecting
            }
            override fun onDeviceDisconnected(device: BluetoothDevice, reason: Int) {
                HrmLog.info(TAG, "Disconnected ${device.address} reason=$reason")
                _connectionState.value = BleConnectionState.Disconnected
                _readings.value = null
                _polarH10.value = false
            }
        })
    }

    override fun isRequiredServiceSupported(gatt: BluetoothGatt): Boolean {
        val hrSvc = gatt.getService(HrBleSpec.HEART_RATE_SERVICE) ?: return false
        hrCharacteristic = hrSvc.getCharacteristic(HrBleSpec.HEART_RATE_MEASUREMENT) ?: return false
        val battSvc = gatt.getService(HrBleSpec.BATTERY_SERVICE)
        batteryCharacteristic = battSvc?.getCharacteristic(HrBleSpec.BATTERY_LEVEL)

        // Optional: detect Polar PMD for ECG streaming. Strap can still
        // deliver HR/RR without it; PMD is opportunistic.
        val pmdSvc = gatt.getService(PolarPmdSpec.PMD_SERVICE)
        if (pmdSvc != null) {
            pmdControlCharacteristic = pmdSvc.getCharacteristic(PolarPmdSpec.PMD_CONTROL_POINT)
            pmdDataCharacteristic = pmdSvc.getCharacteristic(PolarPmdSpec.PMD_DATA_STREAM)
            if (pmdControlCharacteristic != null && pmdDataCharacteristic != null) {
                _polarH10.value = true
                HrmLog.info(TAG, "Polar PMD service present; ECG streaming available")
            }
        }
        return true
    }

    override fun initialize() {
        // Match what a Garmin/Wahoo watch does on connection-ready: request
        // HIGH connection priority (Nordic maps this to Android's
        // CONNECTION_PRIORITY_HIGH → 11.25-15ms intervals, 0 slave latency).
        // Watches are flawless with chest straps partly because they hold
        // this tight interval; the default "balanced" interval (~50ms) is
        // what makes Android BLE feel shaky by comparison.
        requestConnectionPriority(android.bluetooth.BluetoothGatt.CONNECTION_PRIORITY_HIGH).enqueue()
        // PMD frames at 130 Hz fit ~73 samples per notification at MTU 232.
        // Request 247 (Android max) and let the link negotiate down.
        requestMtu(247).enqueue()
        setNotificationCallback(hrCharacteristic)
            .with { _, data ->
                val bytes = data.value ?: return@with
                val reading = HrPacketParser.parse(bytes)
                if (reading != null) _readings.value = reading
            }
        enableNotifications(hrCharacteristic).enqueue()

        val batt = batteryCharacteristic
        if (batt != null) {
            readCharacteristic(batt)
                .with { _, data ->
                    val v = data.value?.firstOrNull()?.toInt()?.and(0xff)
                    if (v != null) _battery.value = v
                }
                .enqueue()
            setNotificationCallback(batt)
                .with { _, data ->
                    val v = data.value?.firstOrNull()?.toInt()?.and(0xff)
                    if (v != null) _battery.value = v
                }
            enableNotifications(batt).enqueue()
        }

        // PMD / Polar H10 ECG path. Enable notifications on both CP and DATA
        // before writing the start command. The SDK enforces a ~200-500 ms
        // gap after CCCDs are enabled; we use sleep() to ensure the write
        // stays ordered after both enableNotifications()'s complete.
        val pmdCp = pmdControlCharacteristic
        val pmdData = pmdDataCharacteristic
        if (pmdCp != null && pmdData != null) {
            setNotificationCallback(pmdCp)
                .with { _, data ->
                    val bytes = data.value ?: return@with
                    val response = PmdControlResponse.parse(bytes)
                    if (response != null) onPmdControlResponse(response)
                }
            enableNotifications(pmdCp).enqueue()

            setNotificationCallback(pmdData)
                .with { _, data ->
                    val bytes = data.value ?: return@with
                    val frame = EcgFrameParser.parse(bytes) ?: return@with
                    _ecgFrames.tryEmit(frame)
                }
            enableNotifications(pmdData).enqueue()

            // 350 ms grace before START so both CCCDs have settled.
            sleep(350).enqueue()
            writeCharacteristic(
                pmdCp,
                PolarPmdCommands.START_H10_ECG,
                BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT,
            ).with { _, _ ->
                HrmLog.info(TAG, "PMD ECG start written")
            }.fail { _, status ->
                HrmLog.warn(TAG, "PMD ECG start write failed status=$status")
            }.enqueue()
        }
    }

    override fun onServicesInvalidated() {
        hrCharacteristic = null
        batteryCharacteristic = null
        pmdControlCharacteristic = null
        pmdDataCharacteristic = null
    }

    private fun onPmdControlResponse(response: PmdControlResponse) {
        when (response.status) {
            PolarPmdSpec.STATUS_SUCCESS -> {
                HrmLog.info(TAG, "PMD op=${response.opCode} type=${response.measurementType} ok")
            }
            PolarPmdSpec.STATUS_ALREADY_IN_STATE -> {
                // Strap says ECG is already streaming — benign on reconnect.
                HrmLog.info(TAG, "PMD ECG already streaming")
            }
            PolarPmdSpec.STATUS_INVALID_STATE -> {
                HrmLog.warn(TAG, "PMD ECG rejected: invalid state (retry after STOP?)")
                // Try a clean stop + restart for future commands. Fire-and-forget.
                pmdControlCharacteristic?.let { cp ->
                    writeCharacteristic(
                        cp,
                        PolarPmdCommands.STOP_ECG,
                        BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT,
                    ).enqueue()
                }
            }
            else -> {
                HrmLog.warn(TAG, "PMD op=${response.opCode} status=${response.status}")
            }
        }
    }

    fun connectStrap(device: BluetoothDevice, autoConnect: Boolean = false) {
        // First connect uses autoConnect=false for fast pairing. Reconnect
        // after link loss uses autoConnect=true so the system keeps trying
        // as soon as the strap advertises again (survives walking out of
        // range and back, strap briefly powering off, etc).
        connect(device)
            .timeout(if (autoConnect) 0L else 15_000L)
            .retry(3, 100)
            .useAutoConnect(autoConnect)
            .enqueue()
    }

    fun disconnectStrap() {
        disconnect().enqueue()
    }

    companion object {
        private const val TAG = "ble"
    }
}

enum class BleConnectionState { Disconnected, Connecting, Ready, Disconnecting }
