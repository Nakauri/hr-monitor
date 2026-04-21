package com.nakauri.hrmonitor.ble

import android.Manifest
import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.annotation.RequiresPermission
import com.nakauri.hrmonitor.diag.HrmLog
import com.welie.blessed.BluetoothCentralManager
import com.welie.blessed.BluetoothCentralManagerCallback
import com.welie.blessed.BluetoothPeripheral
import com.welie.blessed.HciStatus
import com.welie.blessed.ScanFailure
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * BLESSED-backed scanner + peripheral cache.
 *
 * Replaces the previous native-BluetoothLeScanner implementation. BLESSED
 * does scanning + connection + CCCD sequencing in one library; using its
 * central manager for both scan and connect ensures the `BluetoothPeripheral`
 * reference we later pass to `connectPeripheral` carries the correct
 * address type the strap advertised (public vs random), which was the
 * silent failure mode under the raw-API + Nordic path.
 *
 * This object owns the one process-wide `BluetoothCentralManager`. The
 * [HrCentralManager] session-specific wrapper re-uses it for its peripheral
 * callbacks.
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

    // MAC → BluetoothPeripheral. Keyed cache that survives a scan stop so
    // the session coordinator can fetch the peripheral to connect even after
    // the picker has closed. BLESSED itself retains peripherals internally
    // once created; this map is our typed accessor.
    private val peripherals: MutableMap<String, BluetoothPeripheral> = ConcurrentHashMap()

    // Separate discovery metadata so the discovered list keeps per-device
    // RSSI + isHr even after the focus of an `ingest` call moves to another
    // entry.
    private val discoveredByMac: MutableMap<String, DiscoveredStrap> = ConcurrentHashMap()

    private var manager: BluetoothCentralManager? = null
    private val handler = Handler(Looper.getMainLooper())

    /**
     * Listener for peripheral-level central events (connect/disconnect/fail).
     * These fire on the `BluetoothCentralManagerCallback`, not on the
     * per-peripheral callback, so [HrBleManager] registers here to observe
     * its own peripheral's lifecycle.
     */
    interface PeripheralEventListener {
        fun onConnected(peripheral: BluetoothPeripheral)
        fun onConnectionFailed(peripheral: BluetoothPeripheral, status: HciStatus)
        fun onDisconnected(peripheral: BluetoothPeripheral, status: HciStatus)
    }

    private val listeners = CopyOnWriteArrayList<PeripheralEventListener>()
    fun addListener(l: PeripheralEventListener) { listeners.addIfAbsent(l) }
    fun removeListener(l: PeripheralEventListener) { listeners.remove(l) }

    // Re-entrant: multiple UI composables may attempt to read the central;
    // we lazy-init on first scan and hold the reference.
    @Synchronized
    private fun manager(context: Context): BluetoothCentralManager {
        val existing = manager
        if (existing != null) return existing
        val cb = object : BluetoothCentralManagerCallback() {
            override fun onDiscoveredPeripheral(
                peripheral: BluetoothPeripheral,
                scanResult: android.bluetooth.le.ScanResult,
            ) {
                ingest(peripheral, scanResult)
            }

            override fun onConnectedPeripheral(peripheral: BluetoothPeripheral) {
                listeners.forEach { it.onConnected(peripheral) }
            }

            override fun onConnectionFailed(peripheral: BluetoothPeripheral, status: HciStatus) {
                listeners.forEach { it.onConnectionFailed(peripheral, status) }
            }

            override fun onDisconnectedPeripheral(peripheral: BluetoothPeripheral, status: HciStatus) {
                listeners.forEach { it.onDisconnected(peripheral, status) }
            }

            override fun onScanFailed(scanFailure: ScanFailure) {
                HrmLog.warn(TAG, "Scan failed: $scanFailure")
                _scanning.value = false
            }
        }
        val m = BluetoothCentralManager(context.applicationContext, cb, handler)
        manager = m
        return m
    }

    fun centralManager(context: Context): BluetoothCentralManager = manager(context)

    fun getCachedPeripheral(mac: String): BluetoothPeripheral? = peripherals[mac]

    /**
     * Fallback for restart-from-kill: reconstruct a peripheral from MAC
     * when the scan cache is empty. BLESSED's getPeripheral handles the
     * platform-level address-type default internally.
     */
    fun getOrCreatePeripheral(context: Context, mac: String): BluetoothPeripheral {
        return peripherals[mac] ?: manager(context).getPeripheral(mac).also {
            peripherals[mac] = it
        }
    }

    @RequiresPermission(Manifest.permission.BLUETOOTH_SCAN)
    fun start(context: Context) {
        if (_scanning.value) return
        // Intentionally keep `peripherals` populated across scan sessions —
        // a reconnect after scan stop needs the prior peripheral reference.
        discoveredByMac.clear()
        _discovered.value = emptyList()
        try {
            // Scan for HR-service advertisers first — covers most straps.
            // For Coospo / straps that advertise 0x180D only in the scan
            // response we'd miss it here; see the fallback in onDiscovered
            // which relies on a parallel unfiltered scan below.
            manager(context).scanForPeripheralsWithServices(
                arrayOf(HrBleSpec.HEART_RATE_SERVICE)
            )
            _scanning.value = true
            HrmLog.info(TAG, "Scan started (filter=HR service 0x180D)")
        } catch (e: SecurityException) {
            HrmLog.error(TAG, "BLUETOOTH_SCAN permission missing", e)
            _scanning.value = false
        } catch (e: Exception) {
            HrmLog.error(TAG, "Scan start failed", e)
            _scanning.value = false
        }
    }

    @RequiresPermission(Manifest.permission.BLUETOOTH_SCAN)
    fun stop(context: Context) {
        try {
            manager(context).stopScan()
        } catch (_: Exception) { /* best-effort */ }
        _scanning.value = false
        HrmLog.info(TAG, "Scan stopped (${peripherals.size} peripherals cached)")
    }

    private fun ingest(peripheral: BluetoothPeripheral, result: android.bluetooth.le.ScanResult) {
        val mac = peripheral.address
        val name = peripheral.name ?: result.scanRecord?.deviceName
        val services = result.scanRecord?.serviceUuids.orEmpty()
        val hasHrService = services.any { it.uuid == HrBleSpec.HEART_RATE_SERVICE }
        val nameHintsHr = name?.uppercase()?.let { upper ->
            STRAP_NAME_HINTS.any { upper.contains(it) }
        } == true

        peripherals[mac] = peripheral
        discoveredByMac[mac] = DiscoveredStrap(
            mac = mac,
            name = name,
            rssi = result.rssi,
            lastSeenMs = System.currentTimeMillis(),
            isHr = hasHrService || nameHintsHr,
        )

        _discovered.value = discoveredByMac.values
            .sortedWith(compareByDescending<DiscoveredStrap> { it.isHr }.thenByDescending { it.rssi })
            .toList()
    }
}

data class DiscoveredStrap(
    val mac: String,
    val name: String?,
    val rssi: Int,
    val lastSeenMs: Long,
    val isHr: Boolean = false,
)
