package com.nakauri.hrmonitor.ble

import android.bluetooth.BluetoothGattCharacteristic
import android.content.Context
import com.nakauri.hrmonitor.ble.polar.EcgFrameParser
import com.nakauri.hrmonitor.ble.polar.PmdControlResponse
import com.nakauri.hrmonitor.ble.polar.PolarPmdCommands
import com.nakauri.hrmonitor.ble.polar.PolarPmdSpec
import com.nakauri.hrmonitor.diag.HrmLog
import com.welie.blessed.BluetoothPeripheral
import com.welie.blessed.BluetoothPeripheralCallback
import com.welie.blessed.ConnectionPriority
import com.welie.blessed.GattStatus
import com.welie.blessed.HciStatus
import com.welie.blessed.PhyOptions
import com.welie.blessed.PhyType
import com.welie.blessed.WriteType
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * BLESSED-backed BLE session manager. Owns one active peripheral's
 * lifecycle: connect, discover, subscribe, stream. Replaces the prior
 * Nordic BLE Library v2.9 implementation which hit the "services ready
 * but notifications never arrive" Nordic issue #288 on the user's
 * Samsung S8 + Coospo combination.
 *
 * BLESSED is van Welie's library; it handles CCCD descriptor-ack sequencing
 * internally, which is the thing raw-API and Nordic often get wrong.
 *
 * Connection flow:
 *   1. Caller provides a [BluetoothPeripheral] from [HrScanner] (the scan
 *      result already has the correct PUBLIC-vs-RANDOM address type).
 *   2. We register a peripheral callback and ask the central to connect.
 *   3. `onServicesDiscovered` fires — we enable HR notifications, read
 *      battery, optionally kick off the Polar PMD flow for H10.
 *   4. `onCharacteristicUpdate` for 0x2A37 → parsed HrReading emitted.
 *
 * Reconnect on link loss is handled by the caller (SessionCoordinator)
 * re-calling [connectStrap] from its disconnect observer.
 */
class HrBleManager(private val appContext: Context) : HrScanner.PeripheralEventListener {

    private var currentPeripheral: BluetoothPeripheral? = null

    init {
        HrScanner.addListener(this)
    }

    private val _readings = MutableStateFlow<HrReading?>(null)
    val readings: StateFlow<HrReading?> = _readings.asStateFlow()

    private val _battery = MutableStateFlow<Int?>(null)
    val battery: StateFlow<Int?> = _battery.asStateFlow()

    private val _connectionState = MutableStateFlow(BleConnectionState.Disconnected)
    val connectionState: StateFlow<BleConnectionState> = _connectionState.asStateFlow()

    private val _polarH10 = MutableStateFlow(false)
    val polarH10: StateFlow<Boolean> = _polarH10.asStateFlow()

    private val _ecgFrames = MutableSharedFlow<EcgFrameParser.EcgFrame>(
        extraBufferCapacity = 32,
    )
    val ecgFrames: SharedFlow<EcgFrameParser.EcgFrame> = _ecgFrames.asSharedFlow()

    private val peripheralCallback = object : BluetoothPeripheralCallback() {

        override fun onServicesDiscovered(peripheral: BluetoothPeripheral) {
            HrmLog.info(TAG, "Services ready ${peripheral.address}")
            _connectionState.value = BleConnectionState.Ready

            // Verbatim port of weliem/blessed-android sample BluetoothHandler.java's
            // onServicesDiscovered ordering. That sample is van Welie's own
            // reference HR-monitor implementation and is known-working on
            // Samsung + cheap straps. Sequence:
            //   MTU → priority → PHY → DIS reads → battery read → setNotify
            // The four reads (manufacturer + model + PHY + battery) before
            // any setNotify warm up the ATT layer so the CCCD write isn't
            // the very first GATT op after discovery — which on Samsung is
            // documented to silently mis-fire.
            peripheral.requestMtu(185)
            peripheral.requestConnectionPriority(ConnectionPriority.HIGH)
            peripheral.setPreferredPhy(PhyType.LE_2M, PhyType.LE_2M, PhyOptions.S2)

            peripheral.readCharacteristic(HrBleSpec.DIS_SERVICE, HrBleSpec.MANUFACTURER_NAME)
            peripheral.readCharacteristic(HrBleSpec.DIS_SERVICE, HrBleSpec.MODEL_NUMBER)
            peripheral.readPhy()
            peripheral.readCharacteristic(HrBleSpec.BATTERY_SERVICE, HrBleSpec.BATTERY_LEVEL)

            // HR notify — the UUID overload, same as van Welie's sample.
            peripheral.setNotify(
                HrBleSpec.HEART_RATE_SERVICE,
                HrBleSpec.HEART_RATE_MEASUREMENT,
                true,
            )
            // Battery notify — the UUID overload.
            peripheral.setNotify(
                HrBleSpec.BATTERY_SERVICE,
                HrBleSpec.BATTERY_LEVEL,
                true,
            )

            // Polar PMD / H10 ECG — opportunistic. Non-H10 straps don't
            // advertise the PMD service; the setNotify on a missing
            // service is a no-op. We still try the PMD start command;
            // if the strap rejects it (e.g. it's a Coospo, not H10),
            // the response is INVALID_STATE and we ignore.
            val pmdCp = peripheral.getCharacteristic(
                PolarPmdSpec.PMD_SERVICE,
                PolarPmdSpec.PMD_CONTROL_POINT,
            )
            val pmdData = peripheral.getCharacteristic(
                PolarPmdSpec.PMD_SERVICE,
                PolarPmdSpec.PMD_DATA_STREAM,
            )
            if (pmdCp != null && pmdData != null) {
                _polarH10.value = true
                HrmLog.info(TAG, "Polar PMD detected — ECG streaming available")
                peripheral.requestMtu(247)
                peripheral.setNotify(pmdCp, true)
                peripheral.setNotify(pmdData, true)
                peripheral.writeCharacteristic(
                    pmdCp,
                    PolarPmdCommands.START_H10_ECG,
                    WriteType.WITH_RESPONSE,
                )
            } else {
                _polarH10.value = false
            }
        }

        override fun onCharacteristicWrite(
            peripheral: BluetoothPeripheral,
            value: ByteArray,
            characteristic: BluetoothGattCharacteristic,
            status: GattStatus,
        ) {
            if (status != GattStatus.SUCCESS) {
                HrmLog.warn(TAG, "Char write failed uuid=${characteristic.uuid} status=$status")
            }
        }

        override fun onMtuChanged(
            peripheral: BluetoothPeripheral,
            mtu: Int,
            status: GattStatus,
        ) {
            HrmLog.info(TAG, "MTU negotiated: $mtu status=$status")
        }

        override fun onNotificationStateUpdate(
            peripheral: BluetoothPeripheral,
            characteristic: BluetoothGattCharacteristic,
            status: GattStatus,
        ) {
            if (status != GattStatus.SUCCESS) {
                HrmLog.warn(
                    TAG,
                    "Notify state update failed on ${characteristic.uuid}: $status",
                )
                return
            }
            val enabled = peripheral.isNotifying(characteristic)
            HrmLog.info(TAG, "Notifications ${if (enabled) "ON" else "OFF"} for ${characteristic.uuid}")
        }

        override fun onCharacteristicUpdate(
            peripheral: BluetoothPeripheral,
            value: ByteArray,
            characteristic: BluetoothGattCharacteristic,
            status: GattStatus,
        ) {
            if (status != GattStatus.SUCCESS) return
            when (characteristic.uuid) {
                HrBleSpec.HEART_RATE_MEASUREMENT -> {
                    val reading = HrPacketParser.parse(value)
                    if (reading != null) _readings.value = reading
                }
                HrBleSpec.BATTERY_LEVEL -> {
                    val v = value.firstOrNull()?.toInt()?.and(0xff)
                    if (v != null) _battery.value = v
                }
                PolarPmdSpec.PMD_CONTROL_POINT -> {
                    val response = PmdControlResponse.parse(value) ?: return
                    onPmdControlResponse(peripheral, response)
                }
                PolarPmdSpec.PMD_DATA_STREAM -> {
                    val frame = EcgFrameParser.parse(value) ?: return
                    _ecgFrames.tryEmit(frame)
                }
            }
        }

        override fun onConnectionUpdated(
            peripheral: BluetoothPeripheral,
            interval: Int,
            latency: Int,
            timeout: Int,
            status: GattStatus,
        ) {
            HrmLog.info(
                TAG,
                "Conn params: interval=${interval * 1.25}ms latency=$latency timeout=${timeout * 10}ms",
            )
        }
    }

    private fun onPmdControlResponse(peripheral: BluetoothPeripheral, response: PmdControlResponse) {
        when (response.status) {
            PolarPmdSpec.STATUS_SUCCESS -> {
                HrmLog.info(TAG, "PMD op=${response.opCode} type=${response.measurementType} ok")
            }
            PolarPmdSpec.STATUS_ALREADY_IN_STATE -> {
                HrmLog.info(TAG, "PMD ECG already streaming")
            }
            PolarPmdSpec.STATUS_INVALID_STATE -> {
                HrmLog.warn(TAG, "PMD ECG rejected: invalid state, sending STOP")
                peripheral.getCharacteristic(
                    PolarPmdSpec.PMD_SERVICE,
                    PolarPmdSpec.PMD_CONTROL_POINT,
                )?.let { cp ->
                    peripheral.writeCharacteristic(cp, PolarPmdCommands.STOP_ECG, WriteType.WITH_RESPONSE)
                }
            }
            else -> {
                HrmLog.warn(TAG, "PMD op=${response.opCode} status=${response.status}")
            }
        }
    }

    /**
     * Connect to the given peripheral. The central manager is fetched from
     * [HrScanner] so there's only one process-wide BluetoothCentralManager.
     * `autoConnect=true` uses BLESSED's `autoConnectPeripheral`, which
     * holds the request open — recovers automatically when the strap
     * advertises again after a drop.
     */
    fun connectStrap(peripheral: BluetoothPeripheral, autoConnect: Boolean = false) {
        currentPeripheral = peripheral
        _connectionState.value = BleConnectionState.Connecting
        HrmLog.info(TAG, "Connecting to ${peripheral.address} (autoConnect=$autoConnect)")
        val central = HrScanner.centralManager(appContext)
        if (autoConnect) {
            central.autoConnectPeripheral(peripheral, peripheralCallback)
        } else {
            central.connectPeripheral(peripheral, peripheralCallback)
        }
    }

    fun disconnectStrap() {
        val p = currentPeripheral ?: return
        val central = HrScanner.centralManager(appContext)
        central.cancelConnection(p)
    }

    // ---- HrScanner.PeripheralEventListener --------------------------------

    override fun onConnected(peripheral: BluetoothPeripheral) {
        if (peripheral.address != currentPeripheral?.address) return
        HrmLog.info(TAG, "GATT connected ${peripheral.address}")
        // Services-discovery / Ready state transition happens in peripheral
        // callback's onServicesDiscovered; nothing to do here.
    }

    override fun onConnectionFailed(peripheral: BluetoothPeripheral, status: HciStatus) {
        if (peripheral.address != currentPeripheral?.address) return
        HrmLog.warn(TAG, "Failed to connect ${peripheral.address} status=$status")
        _connectionState.value = BleConnectionState.Disconnected
    }

    override fun onDisconnected(peripheral: BluetoothPeripheral, status: HciStatus) {
        if (peripheral.address != currentPeripheral?.address) return
        HrmLog.info(TAG, "Disconnected ${peripheral.address} status=$status")
        _connectionState.value = BleConnectionState.Disconnected
        _readings.value = null
        _polarH10.value = false
    }

    fun close() {
        HrScanner.removeListener(this)
        disconnectStrap()
        currentPeripheral = null
        _connectionState.value = BleConnectionState.Disconnected
        _readings.value = null
        _polarH10.value = false
    }

    companion object {
        private const val TAG = "ble"
    }
}

enum class BleConnectionState { Disconnected, Connecting, Ready, Disconnecting }
