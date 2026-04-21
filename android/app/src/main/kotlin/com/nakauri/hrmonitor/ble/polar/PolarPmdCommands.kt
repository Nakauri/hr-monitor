package com.nakauri.hrmonitor.ble.polar

/**
 * Builders for PMD control-point write bytes. Pre-composed byte arrays the
 * client can push verbatim to `FB005C81-...`.
 *
 * Format per SDK's PmdControlPointCommand.serialize():
 *   [opCode][measurementType][TLV settings…]
 * Each setting: [settingType:1][count:1][values: count * fieldWidth LE]
 * Field widths: sampleRate=2, resolution=2.
 */
object PolarPmdCommands {

    /** `02 00 00 01 82 00 01 01 0E 00` — start ECG @ 130 Hz, 14-bit resolution. */
    val START_H10_ECG: ByteArray = byteArrayOf(
        PolarPmdSpec.OP_REQUEST_MEASUREMENT_START,
        PolarPmdSpec.TYPE_ECG,
        // sample rate TLV: type=0, count=1, value=130 (0x82, 0x00)
        PolarPmdSpec.SETTING_SAMPLE_RATE, 0x01, 0x82.toByte(), 0x00,
        // resolution TLV: type=1, count=1, value=14 (0x0E, 0x00)
        PolarPmdSpec.SETTING_RESOLUTION, 0x01, 0x0E, 0x00,
    )

    /** `03 00` — stop any ECG stream. */
    val STOP_ECG: ByteArray = byteArrayOf(
        PolarPmdSpec.OP_STOP_MEASUREMENT,
        PolarPmdSpec.TYPE_ECG,
    )

    /** `05 00` — query current ECG stream status. Useful on reconnect. */
    val STATUS_ECG: ByteArray = byteArrayOf(
        PolarPmdSpec.OP_GET_MEASUREMENT_STATUS,
        PolarPmdSpec.TYPE_ECG,
    )

    /** `01 00` — list settings the strap supports for ECG. */
    val GET_ECG_SETTINGS: ByteArray = byteArrayOf(
        PolarPmdSpec.OP_GET_MEASUREMENT_SETTINGS,
        PolarPmdSpec.TYPE_ECG,
    )
}

/**
 * Parsed control-point response.
 *
 *   bytes[0]  response-code = 0xF0
 *   bytes[1]  echoed op code
 *   bytes[2]  measurement type
 *   bytes[3]  status
 *   bytes[4]  more flag (non-zero if a fragment follows)
 *   bytes[5..] parameter payload
 */
data class PmdControlResponse(
    val opCode: Byte,
    val measurementType: Byte,
    val status: Byte,
    val hasMoreFragments: Boolean,
    val payload: ByteArray,
) {
    val isSuccess: Boolean get() = status == PolarPmdSpec.STATUS_SUCCESS

    companion object {
        fun parse(bytes: ByteArray): PmdControlResponse? {
            if (bytes.size < 5) return null
            if (bytes[0] != PolarPmdSpec.RESPONSE_HEADER) return null
            return PmdControlResponse(
                opCode = bytes[1],
                measurementType = bytes[2],
                status = bytes[3],
                hasMoreFragments = bytes[4].toInt() != 0,
                payload = if (bytes.size > 5) bytes.copyOfRange(5, bytes.size) else ByteArray(0),
            )
        }
    }
}
