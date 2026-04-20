package com.nakauri.hrmonitor.ui.screens

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
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
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.nakauri.hrmonitor.ble.DiscoveredStrap
import com.nakauri.hrmonitor.ble.HrScanner
import com.nakauri.hrmonitor.data.HrPrefsState
import com.nakauri.hrmonitor.ui.components.PermissionState
import com.nakauri.hrmonitor.ui.components.StatusChip
import com.nakauri.hrmonitor.ui.theme.BrandColors

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
    var showAll by remember { mutableStateOf(false) }

    // Battery-opt status is computed fresh on each recomposition triggered by
    // a lifecycle resume so returning from the system settings reflects the
    // new state. The remember-once version could only be refreshed by a
    // full recomposition cycle, which meant the card lied to the user.
    var batteryExempt by remember { mutableStateOf(isBatteryOptExempt(context)) }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val obs = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                batteryExempt = isBatteryOptExempt(context)
            }
        }
        lifecycleOwner.lifecycle.addObserver(obs)
        onDispose { lifecycleOwner.lifecycle.removeObserver(obs) }
    }

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
                SectionCard(title = "Bluetooth + notification access needed") {
                    Text(
                        "Bluetooth lets us talk to your strap. Notification access keeps the session chip visible while the screen is off.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = permission.request) { Text("Grant access") }
                }
            } else if (!batteryExempt) {
                SectionCard(title = "Keep this app alive in the background") {
                    Text(
                        "Android throttles background apps unless you grant a battery exemption. Without it your stream will drop when the screen turns off.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Spacer(Modifier.height(12.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { requestBatteryOptExemption(context) }) {
                            Text("Grant exemption")
                        }
                        TextButton(onClick = onOpenDiagnostics) { Text("Later") }
                    }
                }
            }

            if (prefs.lastStrapMac != null) {
                SectionCard(title = "Last connected") {
                    Text(
                        prefs.lastStrapName ?: prefs.lastStrapMac,
                        style = MaterialTheme.typography.titleMedium,
                    )
                    if (prefs.lastStrapName != null) {
                        Text(
                            prefs.lastStrapMac,
                            style = MaterialTheme.typography.bodySmall,
                            color = BrandColors.OnSurfaceDim,
                        )
                    }
                    Spacer(Modifier.height(12.dp))
                    Button(
                        onClick = { onSelectStrap(prefs.lastStrapMac, prefs.lastStrapName) },
                        enabled = permission.allGranted,
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Reconnect") }
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

            if (scanning || discovered.isNotEmpty()) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Switch(
                        checked = showAll,
                        onCheckedChange = { showAll = it },
                    )
                    Text(
                        "Show all Bluetooth devices",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }

            val filtered = if (showAll) discovered else discovered.filter { it.isHr }

            if (scanning && filtered.isEmpty()) {
                Text(
                    if (showAll)
                        "Scanning. If nothing appears, the phone may be out of range or Bluetooth scanning is blocked."
                    else
                        "Scanning. Put the strap on or wet the electrodes so it advertises. If your strap is here but not listed, toggle \"Show all\".",
                    style = MaterialTheme.typography.bodySmall,
                    color = BrandColors.OnSurfaceDim,
                )
            }

            if (filtered.isNotEmpty()) {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(filtered, key = { it.mac }) { dev ->
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
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            content()
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
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    dev.name ?: dev.mac,
                    style = MaterialTheme.typography.titleSmall,
                )
                if (dev.isHr) {
                    StatusChip("HR strap", color = BrandColors.AccentRmssd.copy(alpha = 0.18f))
                }
            }
            Text(
                "${dev.mac} • ${dev.rssi} dBm",
                style = MaterialTheme.typography.bodySmall,
                color = BrandColors.OnSurfaceDim,
            )
        }
    }
}

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
