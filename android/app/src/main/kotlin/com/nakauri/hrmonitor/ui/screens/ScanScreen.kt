package com.nakauri.hrmonitor.ui.screens

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.annotation.RequiresPermission
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.nakauri.hrmonitor.ble.DiscoveredStrap
import com.nakauri.hrmonitor.ble.HrScanner
import com.nakauri.hrmonitor.data.HrPrefsState
import com.nakauri.hrmonitor.ui.components.PermissionState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScanScreen(
    prefs: HrPrefsState,
    permission: PermissionState,
    onOpenDiagnostics: () -> Unit,
    onSelectStrap: (mac: String, name: String?) -> Unit,
) {
    val context = LocalContext.current
    val scanning by HrScanner.scanning.collectAsState()
    val discovered by HrScanner.discovered.collectAsState()
    val batteryExempt = remember { isBatteryOptExempt(context) }

    // Stop the scan when the screen leaves composition; scanning on Android
    // 11+ blocks GATT connects until the scan callback is stopped.
    DisposableEffect(Unit) {
        onDispose {
            if (HrScanner.scanning.value && permission.allGranted) stopScanSafe(context)
        }
    }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Pair your strap") },
                actions = {
                    IconButton(onClick = onOpenDiagnostics) {
                        Icon(Icons.Default.Settings, contentDescription = "Diagnostics")
                    }
                }
            )
        }
    ) { inner ->
        Column(
            modifier = Modifier
                .padding(inner)
                .padding(horizontal = 16.dp)
                .fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (!permission.allGranted) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        Text(
                            "Bluetooth + notification access needed",
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "HR Monitor needs Bluetooth to talk to your strap and notification access to show the session chip.",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Spacer(Modifier.height(12.dp))
                        Button(onClick = permission.request) {
                            Text("Grant access")
                        }
                    }
                }
            } else if (!batteryExempt) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        Text(
                            "Keep this app alive in the background",
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "Android kills background BLE sessions unless you grant a battery exemption. Without it your stream will drop when the screen turns off.",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Spacer(Modifier.height(12.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { requestBatteryOptExemption(context) }) {
                                Text("Grant exemption")
                            }
                            TextButton(onClick = onOpenDiagnostics) {
                                Text("Later")
                            }
                        }
                    }
                }
            }

            if (prefs.lastStrapMac != null) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        Text(
                            "Last connected",
                            style = MaterialTheme.typography.labelMedium,
                        )
                        Text(
                            prefs.lastStrapName ?: prefs.lastStrapMac,
                            style = MaterialTheme.typography.titleMedium,
                        )
                        if (prefs.lastStrapName != null) {
                            Text(
                                prefs.lastStrapMac,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        Spacer(Modifier.height(12.dp))
                        Button(
                            onClick = { onSelectStrap(prefs.lastStrapMac, prefs.lastStrapName) },
                            enabled = permission.allGranted,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("Reconnect")
                        }
                    }
                }
            }

            Button(
                onClick = {
                    if (!permission.allGranted) return@Button
                    if (scanning) stopScanSafe(context) else startScanSafe(context)
                },
                enabled = permission.allGranted,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (scanning) "Stop scanning" else "Scan for straps")
            }

            if (scanning && discovered.isEmpty()) {
                Text(
                    "Scanning, put the strap on or wet the electrodes so it starts advertising.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            if (discovered.isNotEmpty()) {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(discovered, key = { it.mac }) { dev ->
                        ScanResultRow(dev) {
                            stopScanSafe(context)
                            onSelectStrap(dev.mac, dev.name)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ScanResultRow(dev: DiscoveredStrap, onTap: () -> Unit) {
    OutlinedButton(
        onClick = onTap,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.fillMaxWidth()) {
            Text(dev.name ?: dev.mac, style = MaterialTheme.typography.titleSmall)
            Text(
                "${dev.mac} • ${dev.rssi} dBm",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

// The UI always gates calls to these by permission.allGranted. Suppressing
// the Lint check rather than sprinkling try/catch through the Compose file.
@SuppressLint("MissingPermission")
private fun startScanSafe(context: Context) = HrScanner.start(context)

@SuppressLint("MissingPermission")
private fun stopScanSafe(context: Context) = HrScanner.stop(context)

private fun isBatteryOptExempt(context: Context): Boolean {
    val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return true
    return pm.isIgnoringBatteryOptimizations(context.packageName)
}

@SuppressLint("BatteryLife")
private fun requestBatteryOptExemption(context: Context) {
    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
        data = Uri.parse("package:${context.packageName}")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    try { context.startActivity(intent) } catch (_: Exception) { /* fall through */ }
}
