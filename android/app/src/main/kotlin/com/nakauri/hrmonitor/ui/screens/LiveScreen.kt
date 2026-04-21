package com.nakauri.hrmonitor.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nakauri.hrmonitor.ble.BleConnectionState
import com.nakauri.hrmonitor.session.RelayConnectionState
import com.nakauri.hrmonitor.session.SessionState
import com.nakauri.hrmonitor.ui.components.StatusChip
import com.nakauri.hrmonitor.ui.theme.BrandColors

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LiveScreen(
    strapLabel: String?,
    onOpenDiagnostics: () -> Unit,
    onStop: () -> Unit,
) {
    val hr by SessionState.hr.collectAsState()
    val rmssd by SessionState.rmssd.collectAsState()
    val battery by SessionState.battery.collectAsState()
    val contactOff by SessionState.contactOff.collectAsState()
    val bleState by SessionState.bleState.collectAsState()
    val relayState by SessionState.relayState.collectAsState()
    val pairingStale by SessionState.pairingStale.collectAsState()

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text(strapLabel ?: "Session") },
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
                .padding(24.dp)
                .fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                hr?.toString() ?: "--",
                fontSize = 128.sp,
                fontWeight = FontWeight.SemiBold,
                color = BrandColors.AccentHr,
            )
            Text(
                "bpm",
                style = MaterialTheme.typography.titleMedium,
                color = BrandColors.OnSurfaceDim,
            )

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusChip("RMSSD ${rmssd?.let { "%.1f".format(it) } ?: "--"} ms")
                StatusChip(relayLabel(relayState))
            }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusChip("BLE ${bleLabel(bleState)}")
                if (battery != null) StatusChip("Strap ${battery}%")
                if (contactOff) StatusChip("Contact off")
            }

            Spacer(Modifier.height(16.dp))

            if (pairingStale) {
                Text(
                    "Couldn't reach the strap after several tries. Stop the session and scan again — the stored device handle may need refreshing.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            } else if (bleState != BleConnectionState.Ready && hr == null) {
                Text(
                    bleStatusExplanation(bleState),
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }

            Spacer(Modifier.weight(1f))

            Button(
                onClick = onStop,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (pairingStale) "Stop and re-pair" else "Stop session")
            }
        }
    }
}

private fun bleLabel(state: BleConnectionState): String = when (state) {
    BleConnectionState.Disconnected -> "offline"
    BleConnectionState.Connecting -> "connecting"
    BleConnectionState.Ready -> "live"
    BleConnectionState.Disconnecting -> "closing"
}

private fun relayLabel(state: RelayConnectionState): String = when (state) {
    RelayConnectionState.Offline -> "Relay offline"
    RelayConnectionState.Connecting -> "Relay connecting"
    RelayConnectionState.Live -> "Relay live"
    RelayConnectionState.Reconnecting -> "Relay reconnecting"
}

private fun bleStatusExplanation(state: BleConnectionState): String = when (state) {
    BleConnectionState.Connecting -> "Connecting to your strap."
    BleConnectionState.Disconnected -> "Strap disconnected. Retrying."
    BleConnectionState.Disconnecting -> "Disconnecting."
    BleConnectionState.Ready -> "Waiting for first heart rate tick."
}
