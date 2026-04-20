package com.nakauri.hrmonitor.relay

import com.nakauri.hrmonitor.diag.HrmLog
import com.nakauri.hrmonitor.session.RelayConnectionState
import com.nakauri.hrmonitor.session.SessionState
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import io.ktor.websocket.send
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.math.min
import kotlin.random.Random

/**
 * Ktor WebSocket client for the PartyKit relay.
 *
 * Connection life cycle:
 *   - [start] opens an outer supervisor coroutine and enters the reconnect loop.
 *   - A successful handshake transitions state to Live. Send channel drains to
 *     the socket; any send failure closes the socket and the outer loop
 *     reconnects.
 *   - On any disconnect the state moves to Reconnecting and the loop waits
 *     (500 ms -> 30 s jittered exponential backoff) before retrying.
 *
 * Drop-and-resume: the client does NOT buffer outbound ticks. If the socket
 * is not Live, [publish] returns false and the coordinator simply skips that
 * tick. Fresh data beats a replay of stale values.
 */
class RelayClient(
    private val url: String,
    private val senderId: String,
    private val senderLabel: String,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val outbox = Channel<String>(capacity = Channel.CONFLATED)

    @Volatile private var runJob: Job? = null
    @Volatile private var live: Boolean = false

    @OptIn(ExperimentalSerializationApi::class)
    fun start() {
        if (runJob != null) return
        runJob = scope.launch { runReconnectLoop() }
    }

    fun stop() {
        runJob?.cancel()
        runJob = null
        live = false
        SessionState.setRelayState(RelayConnectionState.Offline)
    }

    fun isLive(): Boolean = live

    fun publish(message: TickMessage): Boolean {
        if (!live) return false
        val text = json.encodeToString(message)
        return outbox.trySend(text).isSuccess
    }

    fun publish(message: PresenceMessage): Boolean {
        if (!live) return false
        val text = json.encodeToString(message)
        return outbox.trySend(text).isSuccess
    }

    fun publish(message: PresenceEndMessage): Boolean {
        val text = json.encodeToString(message)
        return outbox.trySend(text).isSuccess
    }

    private suspend fun runReconnectLoop() {
        val client = HttpClient(OkHttp) {
            install(WebSockets) {
                // Ktor 3.0.x exposes pingIntervalMillis on the config; the
                // kotlin.time.Duration variant is only in some minor versions.
                // Milliseconds is stable across the 3.0.x range.
                pingIntervalMillis = 20_000
            }
        }

        try {
            var attempt = 0
            while (scope.isActive) {
                SessionState.setRelayState(
                    if (attempt == 0) RelayConnectionState.Connecting else RelayConnectionState.Reconnecting
                )
                val ok = try { connectOnce(client) } catch (e: CancellationException) { throw e } catch (e: Throwable) {
                    HrmLog.warn(TAG, "Relay failure: ${e.message}")
                    false
                }
                if (ok) {
                    attempt = 0
                } else {
                    attempt += 1
                    val delayMs = jitteredBackoff(attempt)
                    HrmLog.info(TAG, "Relay reconnect in ${delayMs}ms (attempt $attempt)")
                    delay(delayMs)
                }
            }
        } finally {
            live = false
            SessionState.setRelayState(RelayConnectionState.Offline)
            client.close()
        }
    }

    private suspend fun connectOnce(client: HttpClient): Boolean {
        var cleanClose = false
        try {
            client.webSocket(urlString = url) {
                HrmLog.info(TAG, "Relay connected: $url")
                live = true
                SessionState.setRelayState(RelayConnectionState.Live)

                // Outbound pump: drain outbox to frames. Separate coroutine so
                // an idle send doesn't block inbound processing.
                val pump = launch {
                    for (text in outbox) {
                        try { send(text) } catch (e: Throwable) {
                            HrmLog.warn(TAG, "Relay send failed: ${e.message}")
                            close(CloseReason(CloseReason.Codes.INTERNAL_ERROR, "send failed"))
                            break
                        }
                    }
                }

                // Inbound drain: we do not consume control messages yet, but
                // reading the channel is required to keep the socket healthy.
                try {
                    for (frame in incoming) {
                        if (frame is Frame.Text) {
                            // Phase 3 ignores inbound control messages. Phase 4+
                            // wires "action=stop" to end the session gracefully.
                            val text = frame.readText()
                            if (text.contains("\"control\"")) {
                                HrmLog.info(TAG, "Relay inbound control (ignored for Phase 3)")
                            }
                        }
                    }
                } finally {
                    pump.cancel()
                }
                cleanClose = true
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            HrmLog.warn(TAG, "Relay connect error: ${e.message}")
        } finally {
            live = false
            SessionState.setRelayState(RelayConnectionState.Reconnecting)
        }
        return cleanClose
    }

    private fun jitteredBackoff(attempt: Int): Long {
        val base = min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * (1L shl min(attempt - 1, 6)))
        val jitter = (Random.nextDouble() * base * 0.3).toLong()
        return (base - base / 6) + jitter
    }

    companion object {
        private const val TAG = "relay"
        private const val BACKOFF_BASE_MS = 500L
        private const val BACKOFF_MAX_MS = 30_000L
    }
}
