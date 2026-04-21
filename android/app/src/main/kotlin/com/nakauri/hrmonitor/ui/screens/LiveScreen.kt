package com.nakauri.hrmonitor.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.nakauri.hrmonitor.ble.BleConnectionState
import com.nakauri.hrmonitor.session.HrStages
import com.nakauri.hrmonitor.session.RelayConnectionState
import com.nakauri.hrmonitor.session.SessionState
import com.nakauri.hrmonitor.ui.components.HeartIcon
import com.nakauri.hrmonitor.ui.components.HrPips
import com.nakauri.hrmonitor.ui.components.LiveTrace
import com.nakauri.hrmonitor.ui.theme.BrandColors

/**
 * Native recreation of the desktop compact widget (widget.css + widget.js).
 *
 * Layout mirrors the CSS grid: header row across the top (heart icon + "HR"
 * label on left, conn dot on right), then below — big stage-coloured HR
 * number with the inline live trace flex-filling the remaining column
 * width, plus the RMSSD block on the right separated by a thin vertical
 * divider. Pips row fills below. Battery + contact chips ride below the
 * widget card.
 *
 * Dimensions scaled for phone: 72 sp HR number (vs 64 px desktop) so it
 * reads from arm's length; trace is 80 dp tall; card fills width.
 */
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
    val hrSeries by SessionState.hrSeries.collectAsState()
    val polarH10 by SessionState.polarH10.collectAsState()

    val stageKey = hr?.let { HrStages.hrStage(it) }
    val stageColor = stageKey?.let { BrandColors.stageColor(it) } ?: BrandColors.OnSurfaceDim

    // Beat period drives the heart icon pulse. Default 1s when idle; sync
    // to the live HR once we have a reading (60000/hr = ms per beat).
    val beatMs = hr?.let { (60_000 / it.coerceAtLeast(30)).coerceIn(350, 2000) } ?: 1000

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
                .padding(horizontal = 16.dp, vertical = 12.dp)
                .fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            WidgetCard(
                hr = hr,
                stageKey = stageKey,
                stageColor = stageColor,
                rmssd = rmssd,
                relayState = relayState,
                bleState = bleState,
                beatMs = beatMs,
                hrSeries = hrSeries,
            )

            InfoChipsRow(battery = battery, contactOff = contactOff, polarH10 = polarH10)

            if (pairingStale) {
                Text(
                    "Couldn't reach the strap. Stop and re-pair to refresh the device handle.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                    textAlign = TextAlign.Center,
                )
            } else if (hr == null) {
                Text(
                    bleStatusLine(bleState),
                    style = MaterialTheme.typography.bodySmall,
                    color = BrandColors.OnSurfaceDim,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
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

@Composable
private fun WidgetCard(
    hr: Int?,
    stageKey: String?,
    stageColor: Color,
    rmssd: Double?,
    relayState: RelayConnectionState,
    bleState: BleConnectionState,
    beatMs: Int,
    hrSeries: List<SessionState.HrPoint>,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(BrandColors.Background, RoundedCornerShape(16.dp))
            .border(1.dp, BrandColors.SurfaceVariant, RoundedCornerShape(16.dp))
            .padding(horizontal = 18.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // Header: heart icon + "HR" label on left, conn dot on right.
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                HeartIcon(
                    color = stageColor,
                    modifier = Modifier.size(22.dp),
                    beatMs = beatMs,
                )
                Spacer(Modifier.width(10.dp))
                Text(
                    "HR",
                    color = BrandColors.OnSurfaceDim,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = 0.1f.em,
                    fontSize = 14.sp,
                )
            }
            ConnDot(relay = relayState, ble = bleState)
        }

        // Row 2: big number + inline live trace on col 1; RMSSD on col 2.
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                modifier = Modifier.weight(1f),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = hr?.toString() ?: "--",
                    color = stageColor,
                    fontSize = 72.sp,
                    fontWeight = FontWeight.Black,
                    letterSpacing = (-0.04f).em,
                )
                Spacer(Modifier.width(14.dp))
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(68.dp),
                ) {
                    LiveTrace(
                        points = hrSeries,
                        windowMs = 45_000L,
                        lineColor = stageColor,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
            // Thin vertical divider.
            Box(
                modifier = Modifier
                    .padding(horizontal = 14.dp)
                    .width(1.dp)
                    .height(56.dp)
                    .background(BrandColors.SurfaceVariant)
            )
            // RMSSD block on the right.
            Column(
                horizontalAlignment = Alignment.End,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    "RMSSD",
                    color = Color(0xFFC8C8C8),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 0.12f.em,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    rmssd?.let { "%.0f".format(it) } ?: "--",
                    color = BrandColors.AccentRmssd,
                    fontSize = 40.sp,
                    fontWeight = FontWeight.Black,
                    letterSpacing = (-0.03f).em,
                )
                Text(
                    "ms",
                    color = BrandColors.OnSurfaceDim,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = 0.1f.em,
                )
            }
        }

        // Pips row.
        HrPips(activeStageKey = stageKey)
    }
}

@Composable
private fun ConnDot(relay: RelayConnectionState, ble: BleConnectionState) {
    val (color, label) = when {
        ble != BleConnectionState.Ready -> Color(0xFF6A6A6A) to "strap"
        relay == RelayConnectionState.Live -> BrandColors.AccentRmssd to "live"
        relay == RelayConnectionState.Connecting || relay == RelayConnectionState.Reconnecting ->
            Color(0xFF6A6A6A) to "reconnecting"
        else -> Color(0xFF3A3A3A) to "offline"
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (label != "live") {
            Text(
                label.uppercase(),
                color = BrandColors.OnSurfaceDim,
                fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.1f.em,
            )
            Spacer(Modifier.width(6.dp))
        }
        Box(
            modifier = Modifier
                .size(9.dp)
                .background(color, RoundedCornerShape(50))
        )
    }
}

@Composable
private fun InfoChipsRow(battery: Int?, contactOff: Boolean, polarH10: Boolean) {
    val chips = buildList {
        if (battery != null) add("Strap ${battery}%")
        if (contactOff) add("Contact off")
        if (polarH10) add("Polar H10 (ECG)")
    }
    if (chips.isEmpty()) return
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        chips.forEach { chipText ->
            Box(
                modifier = Modifier
                    .background(BrandColors.SurfaceVariant, RoundedCornerShape(999.dp))
                    .padding(horizontal = 10.dp, vertical = 4.dp),
            ) {
                Text(
                    chipText,
                    style = MaterialTheme.typography.labelSmall,
                    color = BrandColors.OnSurfaceDim,
                )
            }
        }
    }
}

private fun bleStatusLine(state: BleConnectionState): String = when (state) {
    BleConnectionState.Connecting -> "Connecting to strap"
    BleConnectionState.Disconnected -> "Strap offline. Retrying"
    BleConnectionState.Disconnecting -> "Disconnecting"
    BleConnectionState.Ready -> "Waiting for first tick"
}

