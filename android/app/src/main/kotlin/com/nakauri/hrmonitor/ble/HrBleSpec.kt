package com.nakauri.hrmonitor.ble

import java.util.UUID

/** Bluetooth SIG assigned numbers for the heart rate profile. */
object HrBleSpec {
    val HEART_RATE_SERVICE: UUID = UUID.fromString("0000180d-0000-1000-8000-00805f9b34fb")
    val HEART_RATE_MEASUREMENT: UUID = UUID.fromString("00002a37-0000-1000-8000-00805f9b34fb")
    val BATTERY_SERVICE: UUID = UUID.fromString("0000180f-0000-1000-8000-00805f9b34fb")
    val BATTERY_LEVEL: UUID = UUID.fromString("00002a19-0000-1000-8000-00805f9b34fb")
}

/**
 * A single heart rate notification parsed from characteristic 0x2A37.
 *
 * @param hr Beats per minute. The spec allows UINT8 or UINT16; we return an Int.
 * @param rrIntervalsMs Optional RR intervals for the last beat(s), in milliseconds.
 *   Straps deliver one or more 1/1024 s increments per notification. Empty list
 *   when the strap does not include RR data (required for RMSSD).
 * @param contactDetected Null if the sensor does not support contact detection,
 *   true if skin contact is confirmed, false if the strap reports "no contact".
 * @param timestampMs Monotonic wall clock at receive time for sequencing.
 */
data class HrReading(
    val hr: Int,
    val rrIntervalsMs: List<Int>,
    val contactDetected: Boolean?,
    val timestampMs: Long,
)

/**
 * Parses a raw heart rate measurement characteristic value into [HrReading].
 * Matches the parseHR offsets used by the web app (hr_monitor.html).
 *
 * Byte layout:
 *   byte 0: flags (bit 0 = 16-bit HR, bits 1-2 = contact, bit 3 = energy, bit 4 = RR)
 *   byte 1 or bytes 1-2: HR value
 *   optional 2 bytes: energy expended
 *   optional N * 2 bytes: RR intervals (1/1024 s, little endian)
 */
object HrPacketParser {
    fun parse(bytes: ByteArray, nowMs: Long = System.currentTimeMillis()): HrReading? {
        if (bytes.isEmpty()) return null
        val flags = bytes[0].toInt() and 0xff
        val is16 = (flags and 0x01) != 0
        val contactSupported = (flags and 0x04) != 0
        val contactDetected = when {
            !contactSupported -> null
            (flags and 0x02) != 0 -> true
            else -> false
        }
        val hasEnergy = (flags and 0x08) != 0
        val hasRr = (flags and 0x10) != 0

        var offset = 1
        val hr = if (is16) {
            if (bytes.size < offset + 2) return null
            val lo = bytes[offset].toInt() and 0xff
            val hi = bytes[offset + 1].toInt() and 0xff
            offset += 2
            (hi shl 8) or lo
        } else {
            if (bytes.size < offset + 1) return null
            (bytes[offset].toInt() and 0xff).also { offset += 1 }
        }
        if (hasEnergy) offset += 2

        val rrList = mutableListOf<Int>()
        if (hasRr) {
            while (bytes.size >= offset + 2) {
                val lo = bytes[offset].toInt() and 0xff
                val hi = bytes[offset + 1].toInt() and 0xff
                val raw = (hi shl 8) or lo
                // Convert 1/1024 s units to ms.
                rrList += (raw * 1000 / 1024)
                offset += 2
            }
        }

        return HrReading(
            hr = hr,
            rrIntervalsMs = rrList,
            contactDetected = contactDetected,
            timestampMs = nowMs,
        )
    }
}
