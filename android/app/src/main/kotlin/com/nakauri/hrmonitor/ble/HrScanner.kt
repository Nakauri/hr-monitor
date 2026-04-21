package com.nakauri.hrmonitor.ble

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.ParcelUuid
import androidx.annotation.RequiresPermission
import com.nakauri.hrmonitor.diag.HrmLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.ConcurrentHashMap

/**
 * Unfiltered BLE scanner. The original design filtered on the HR service
 * UUID (0x180D) to keep phones and keyboards out of the picker, but many
 * straps (including the Coospo H808S this project targets) advertise
 * 0x180D only in the scan response or post-connection — the primary
 * advertisement doesn't carry it, and ScanFilter.setServiceUuid can't
 * see scan-response payloads reliably on every OEM.
 *
 * Consequence: scan everything, classify in [ingest]. Devices whose scan
 * record exposes 0x180D are marked `isHr = true` and float to the top.
 * Named-but-unknown devices sit below. `showAll = false` on [discovered]
 * hides anonymous noise; the UI offers a "Show all" toggle for the edge
 * case where a strap has neither 0x180D in scan record nor a known name.
 */
object HrScanner {
    private const val TAG = "scan"

    private val STRAP_NAME_HINTS = listOf(
        "COOSPO", "H808", "H10", "H7", "H6", "POLAR", "GARMIN", "WAHOO",
        "HRM", "TICKR", "SCOSCHE", "HEART RATE",
    )

    private val _scanning = MutableStateFlow(false)
    val scanning: StateFlow<Boolean> = _scanning.asStateFlow()

    private val _discovered = MutableStateFlow<List<DiscoveredStrap>>(emptyList())
    val discovered: StateFlow<List<DiscoveredStrap>> = _discovered.asStateFlow()

    // `byMac` is only touched on the scan-callback thread during ingest and
    // read on that same thread for the sorted snapshot. `_discovered` is the
    // safe snapshot the UI observes.
    private val byMac = linkedMapOf<String, DiscoveredStrap>()

    /**
     * Keeps the actual BluetoothDevice objects from scan. `getRemoteDevice(mac)`
     * defaults to address-type PUBLIC, which silently fails to connect when
     * the strap advertises with a RANDOM address (the Coospo H808S, among
     * others). Looking up the device from this cache preserves the address
     * type the stack already learned at scan time.
     *
     * Accessed from the binder scan-callback thread (writes) and the main
     * Compose thread (reads), so must be thread-safe. Bounded by LRU eviction
     * so hours of ambient BLE devices don't leak.
     */
    private const val DEVICE_CACHE_CAPACITY = 64
    private val deviceCache: MutableMap<String, BluetoothDevice> =
        java.util.Collections.synchronizedMap(
            object : java.util.LinkedHashMap<String, BluetoothDevice>(DEVICE_CACHE_CAPACITY, 0.75f, true) {
                override fun removeEldestEntry(eldest: Map.Entry<String, BluetoothDevice>?): Boolean =
                    size > DEVICE_CACHE_CAPACITY
            }
        )

    private var callback: ScanCallback? = null

    /** Returns the live BluetoothDevice handle from scan, or null if never seen. */
    fun getCachedDevice(mac: String): BluetoothDevice? = deviceCache[mac]

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
        // deviceCache intentionally NOT cleared here — stale device objects
        // from a previous scan can still be used for a reconnect after the
        // user has stopped scanning.
        _discovered.value = emptyList()

        // No service-UUID filter — see class doc. Rely on client-side
        // classification in ingest().
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
            scanner.startScan(null, settings, cb)
            _scanning.value = true
            HrmLog.info(TAG, "Scan started (unfiltered)")
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
            // Best-effort. Revoked BLUETOOTH_SCAN mid-scan just drops results.
        }
        callback = null
        _scanning.value = false
        HrmLog.info(TAG, "Scan stopped (${byMac.size} results)")
    }

    @SuppressLint("MissingPermission")
    private fun ingest(result: ScanResult) {
        val device = result.device ?: return
        val mac = device.address ?: return
        val scanName = result.scanRecord?.deviceName
        val btName = try { device.name } catch (_: SecurityException) { null }
        val name = scanName ?: btName

        val serviceUuids = result.scanRecord?.serviceUuids.orEmpty()
        val hasHrService = serviceUuids.any { it == ParcelUuid(HrBleSpec.HEART_RATE_SERVICE) }
        val nameHintsHr = name?.uppercase()?.let { upper -> STRAP_NAME_HINTS.any { upper.contains(it) } } == true

        deviceCache[mac] = device

        val entry = DiscoveredStrap(
            mac = mac,
            name = name,
            rssi = result.rssi,
            lastSeenMs = System.currentTimeMillis(),
            isHr = hasHrService || nameHintsHr,
        )
        byMac[mac] = entry

        _discovered.value = byMac.values
            .sortedWith(
                compareByDescending<DiscoveredStrap> { it.isHr }
                    .thenByDescending { it.rssi }
            )
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
    val isHr: Boolean = false,
)
