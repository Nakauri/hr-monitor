package com.nakauri.hrmonitor.relay

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Outbound messages to the PartyKit relay. Field names match the web app
 * publisher exactly so overlay.html can consume either source.
 *
 * Phase 3 sends a reduced tick: hr, hrStage, rmssd, rmssdStage, contactOff,
 * conn. Livepoints, trends, prefs, widgetSize are omitted; overlay.html
 * falls back gracefully when those fields are absent. Full tick parity
 * (trends + ectopic detection) lands in a later phase.
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
