package com.nakauri.hrmonitor.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
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
    var scanning by remember { mutableStateOf(false) }

    // Phase 1 placeholder devices. Phase 2 replaces with real Nordic BLE scan.
    val placeholderDevices = remember {
        listOf(
            ScanResultStub("AA:BB:CC:DD:EE:01", "COOSPO H808S", rssi = -48),
            ScanResultStub("AA:BB:CC:DD:EE:02", "Polar H10 9D1B", rssi = -62),
        )
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
                onClick = { scanning = !scanning },
                enabled = permission.allGranted,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (scanning) "Stop scanning" else "Scan for straps")
            }

            if (scanning) {
                Text(
                    "Scanning — Phase 2 wires the real Nordic BLE scan.",
                    style = MaterialTheme.typography.bodySmall,
                )
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(placeholderDevices) { dev ->
                        ScanResultRow(dev) {
                            onSelectStrap(dev.mac, dev.name)
                        }
                    }
                }
            }
        }
    }
}

private data class ScanResultStub(
    val mac: String,
    val name: String?,
    val rssi: Int,
)

@Composable
private fun ScanResultRow(dev: ScanResultStub, onTap: () -> Unit) {
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
