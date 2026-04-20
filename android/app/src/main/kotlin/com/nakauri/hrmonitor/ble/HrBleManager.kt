package com.nakauri.hrmonitor.ble

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.content.Context
import com.nakauri.hrmonitor.diag.HrmLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import no.nordicsemi.android.ble.BleManager
import no.nordicsemi.android.ble.observer.ConnectionObserver

/**
 * Nordic BleManager subclass for the HR service (0x180D). Subscribes to
 * the heart rate measurement characteristic (0x2A37) and optionally reads
 * battery level (0x180F / 0x2A19).
 *
 * The Nordic library handles 133-retry (the infamous Android GATT error),
 * bond races, and MTU negotiation for us. We add:
 *   - HR packet parsing via [HrPacketParser]
 *   - StateFlow exposure so the service and UI can observe readings
 *   - Silent-connection detection timer (reset on each notification)
 *
 * Reconnect is handled by the caller: when [connectionState] transitions
 * to [BleConnectionState.Disconnected] and the session is still active,
 * the SessionCoordinator calls [connectStrap] again.
 */
class HrBleManager(context: Context) : BleManager(context) {

    private var hrCharacteristic: BluetoothGattCharacteristic? = null
    private var batteryCharacteristic: BluetoothGattCharacteristic? = null

    private val _readings = MutableStateFlow<HrReading?>(null)
    val readings: StateFlow<HrReading?> = _readings.asStateFlow()

    private val _battery = MutableStateFlow<Int?>(null)
    val battery: StateFlow<Int?> = _battery.asStateFlow()

    private val _connectionState = MutableStateFlow(BleConnectionState.Disconnected)
    val connectionState: StateFlow<BleConnectionState> = _connectionState.asStateFlow()

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
            }
        })
    }

    override fun isRequiredServiceSupported(gatt: BluetoothGatt): Boolean {
        val hrSvc = gatt.getService(HrBleSpec.HEART_RATE_SERVICE) ?: return false
        hrCharacteristic = hrSvc.getCharacteristic(HrBleSpec.HEART_RATE_MEASUREMENT) ?: return false
        val battSvc = gatt.getService(HrBleSpec.BATTERY_SERVICE)
        batteryCharacteristic = battSvc?.getCharacteristic(HrBleSpec.BATTERY_LEVEL)
        return true
    }

    override fun initialize() {
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
    }

    override fun onServicesInvalidated() {
        hrCharacteristic = null
        batteryCharacteristic = null
    }

    fun connectStrap(device: BluetoothDevice) {
        connect(device)
            .timeout(15_000)
            .retry(3, 100)
            .useAutoConnect(false)
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
