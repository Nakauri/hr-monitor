package com.nakauri.hrmonitor.ble.polar

/**
 * Parses PMD data-stream notifications into ECG sample frames.
 *
 * Frame layout (bytes from the characteristic notify value):
 *   [0]        measurement type (ECG = 0x00)
 *   [1..8]     timestamp — uint64 LE, ns since 2000-01-01 UTC (Polar epoch)
 *   [9]        frame type byte
 *                  bit 7 = compressed flag (ECG on H10: always 0)
 *                  bits 0..6 = frame type index
 *   [10..end]  data content
 *
 * For H10 ECG we only expect frame type 0: signed 24-bit LE microvolt
 * samples, 3 bytes per sample. Other frame types exist for newer devices
 * (H13, Sense) and will be ignored by this parser with a TAG log line.
 */
object EcgFrameParser {

    /** Per-sample microvolts from a parsed type-0 frame. */
    data class EcgFrame(
        val timestampUnixMs: Long,
        val sampleRateHz: Int = PolarPmdSpec.H10_SAMPLE_RATE_HZ,
        val samplesMicroVolts: IntArray,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is EcgFrame) return false
            return timestampUnixMs == other.timestampUnixMs &&
                sampleRateHz == other.sampleRateHz &&
                samplesMicroVolts.contentEquals(other.samplesMicroVolts)
        }
        override fun hashCode(): Int {
            var r = timestampUnixMs.hashCode()
            r = 31 * r + sampleRateHz
            r = 31 * r + samplesMicroVolts.contentHashCode()
            return r
        }
    }

    fun parse(bytes: ByteArray): EcgFrame? {
        if (bytes.size < 10) return null
        val measurementType = bytes[0]
        if (measurementType != PolarPmdSpec.TYPE_ECG) return null

        val polarNs = readUint64Le(bytes, 1)
        val frameTypeByte = bytes[9].toInt() and 0xff
        val compressed = (frameTypeByte and 0x80) != 0
        val frameType = frameTypeByte and 0x7f
        if (compressed || frameType != 0) {
            // H10 only emits type 0 uncompressed. Anything else is a newer
            // sensor variant; swallow silently so we don't corrupt state.
            return null
        }

        val dataStart = 10
        val dataLen = bytes.size - dataStart
        if (dataLen <= 0 || dataLen % 3 != 0) return null
        val sampleCount = dataLen / 3
        val samples = IntArray(sampleCount)
        var cursor = dataStart
        for (i in 0 until sampleCount) {
            samples[i] = readInt24Le(bytes, cursor)
            cursor += 3
        }

        val timestampUnixMs = (polarNs / 1_000_000L) + PolarPmdSpec.POLAR_EPOCH_UNIX_MS
        return EcgFrame(
            timestampUnixMs = timestampUnixMs,
            samplesMicroVolts = samples,
        )
    }

    // Little-endian unsigned 64-bit timestamp.
    private fun readUint64Le(b: ByteArray, offset: Int): Long {
        var v = 0L
        for (i in 0..7) {
            v = v or ((b[offset + i].toLong() and 0xFFL) shl (8 * i))
        }
        return v
    }

    // Signed 24-bit little-endian. Sign extended from bit 23.
    private fun readInt24Le(b: ByteArray, offset: Int): Int {
        val raw = (b[offset].toInt() and 0xFF) or
            ((b[offset + 1].toInt() and 0xFF) shl 8) or
            ((b[offset + 2].toInt() and 0xFF) shl 16)
        return if ((raw and 0x800000) != 0) raw or 0xFF000000.toInt() else raw
    }
}
