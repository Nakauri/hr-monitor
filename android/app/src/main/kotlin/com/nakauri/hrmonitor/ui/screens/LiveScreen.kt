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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nakauri.hrmonitor.ui.components.StatusChip

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LiveScreen(
    hr: Int?,
    rmssd: Double?,
    strapLabel: String?,
    onOpenDiagnostics: () -> Unit,
    onStop: () -> Unit,
) {
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
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                hr?.toString() ?: "--",
                fontSize = 128.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text("bpm", style = MaterialTheme.typography.titleMedium)

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusChip("RMSSD ${rmssd?.let { "%.1f".format(it) } ?: "--"} ms")
                StatusChip("Relay offline")
            }

            Spacer(Modifier.height(24.dp))

            Text(
                "Live trace lands when Phase 2 wires the real BLE stream.",
                style = MaterialTheme.typography.bodySmall,
            )

            Spacer(Modifier.weight(1f))

            Button(
                onClick = onStop,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Stop session")
            }
        }
    }
}
