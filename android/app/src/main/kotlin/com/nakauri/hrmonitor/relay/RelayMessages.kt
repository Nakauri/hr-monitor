package com.nakauri.hrmonitor.relay

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Outbound messages to the PartyKit relay. Field names match the web app
 * publisher exactly so overlay.html can consume either source.
 *
 * Native publisher sends hr, hrStage, rmssd, rmssdStage, contactOff, conn,
 * prefs, widgetSize. Omitted: livePoints + liveWindow (45s sparkline),
 * trendHR + trendRmssd + trendWindow (3-min trends). The overlay renders
 * blank chart canvases for those without affecting the big HR number or
 * RMSSD display.
 *
 * prefs is load-bearing — without it the overlay cannot apply the
 * show/hide toggles and every section renders regardless of user choice.
 * widgetSize scopes the OBS capture source.
 */
@Serializable
data class TickMessage(
    val type: String = "tick",
    val senderId: String,
    val senderLabel: String,
    val senderBooted: Long,
    val t: Double,
    val hr: Int? = null,
    val hrStage: String? = null,
    val rmssd: Double? = null,
    val rmssdStage: String? = null,
    val palpPerMin: Double = 0.0,
    val contactOff: Boolean = false,
    val warn: String? = null,
    val conn: String = "live",
    val prefs: WidgetPrefs = WidgetPrefs(),
    val widgetSize: WidgetSize = WidgetSize(),
)

@Serializable
data class WidgetPrefs(
    val showHr: Boolean = true,
    val showHrv: Boolean = true,
    // Sparkline + trend charts require livePoints / trend arrays the native
    // publisher does not yet compute. Hidden so the overlay does not show
    // empty chart frames.
    val showLiveHr: Boolean = false,
    val showInlineTrends: Boolean = false,
    // Palpitation detection not ported yet.
    val showPalpChip: Boolean = false,
    // Warning logic not ported yet.
    val showWarning: Boolean = false,
    val showConnDot: Boolean = true,
    val warningPlacement: String = "inside",
)

@Serializable
data class WidgetSize(
    // Matches the monitor's 380px overlay-zone column. Height is measured
    // for the native's reduced widget (big number + RMSSD chip + conn dot).
    val w: Int = 380,
    val h: Int = 140,
)

@Serializable
data class PresenceMessage(
    val type: String = "presence",
    val senderId: String,
    val senderLabel: String,
    val startedAt: Long,
    val connState: String,
)

@Serializable
data class PresenceEndMessage(
    val type: String = "presence-end",
    val senderId: String,
)

@Serializable
data class ControlMessage(
    val type: String = "control",
    val action: String,
    val targetId: String? = null,
    val senderId: String,
)

/** Discriminator helper when parsing inbound messages. */
@Serializable
data class MessageEnvelope(
    val type: String,
    @SerialName("senderId") val senderId: String? = null,
    val targetId: String? = null,
    val action: String? = null,
)
