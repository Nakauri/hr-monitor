package com.nakauri.hrmonitor.ble

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.ParcelUuid
import androidx.annotation.RequiresPermission
import com.nakauri.hrmonitor.diag.HrmLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Native BluetoothLeScanner wrapper. Filters on the HR service UUID so
 * phones, keyboards, and random BLE junk stay out of the picker.
 *
 * [discovered] is keyed by MAC, newest reading wins so RSSI stays fresh.
 * The scanner must be stopped before starting a connection on Android 11+,
 * otherwise the scanner holds the radio and GATT connect times out.
 */
object HrScanner {
    private const val TAG = "scan"

    private val _scanning = MutableStateFlow(false)
    val scanning: StateFlow<Boolean> = _scanning.asStateFlow()

    private val _discovered = MutableStateFlow<List<DiscoveredStrap>>(emptyList())
    val discovered: StateFlow<List<DiscoveredStrap>> = _discovered.asStateFlow()

    private val byMac = linkedMapOf<String, DiscoveredStrap>()
    private var callback: ScanCallback? = null

    @RequiresPermission(Manifest.permission.BLUETOOTH_SCAN)
    fun start(context: Context) {
        if (_scanning.value) return
        val adapter = adapter(context) ?: run {
            HrmLog.warn(TAG, "No Bluetooth adapter on this device")
            return
        }
        if (!adapter.isEnabled) {
            HrmLog.warn(TAG, "Bluetooth is off — prompt user to enable")
            return
        }
        val scanner = adapter.bluetoothLeScanner ?: run {
            HrmLog.warn(TAG, "bluetoothLeScanner null (airplane mode?)")
            return
        }

        byMac.clear()
        _discovered.value = emptyList()

        val filter = ScanFilter.Builder()
            .setServiceUuid(ParcelUuid(HrBleSpec.HEART_RATE_SERVICE))
            .build()
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
            .build()

        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                ingest(result)
            }

            override fun onBatchScanResults(results: MutableList<ScanResult>) {
                results.forEach(::ingest)
            }

            override fun onScanFailed(errorCode: Int) {
                HrmLog.warn(TAG, "Scan failed errorCode=$errorCode")
                _scanning.value = false
            }
        }
        callback = cb
        try {
            scanner.startScan(listOf(filter), settings, cb)
            _scanning.value = true
            HrmLog.info(TAG, "Scan started")
        } catch (e: SecurityException) {
            HrmLog.error(TAG, "BLUETOOTH_SCAN permission missing", e)
            _scanning.value = false
        }
    }

    @RequiresPermission(Manifest.permission.BLUETOOTH_SCAN)
    fun stop(context: Context) {
        val cb = callback ?: return
        try {
            adapter(context)?.bluetoothLeScanner?.stopScan(cb)
        } catch (_: SecurityException) {
            // Best-effort stop. If BLUETOOTH_SCAN was revoked mid-scan,
            // the scan list clears itself.
        }
        callback = null
        _scanning.value = false
        HrmLog.info(TAG, "Scan stopped (${byMac.size} results)")
    }

    @SuppressLint("MissingPermission")
    private fun ingest(result: ScanResult) {
        val device = result.device ?: return
        val mac = device.address ?: return
        val name = try { device.name } catch (_: SecurityException) { null } ?: result.scanRecord?.deviceName
        val entry = DiscoveredStrap(
            mac = mac,
            name = name,
            rssi = result.rssi,
            lastSeenMs = System.currentTimeMillis(),
        )
        byMac[mac] = entry
        _discovered.value = byMac.values
            .sortedByDescending { it.rssi }
            .toList()
    }

    private fun adapter(context: Context): BluetoothAdapter? =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
}

data class DiscoveredStrap(
    val mac: String,
    val name: String?,
    val rssi: Int,
    val lastSeenMs: Long,
)
