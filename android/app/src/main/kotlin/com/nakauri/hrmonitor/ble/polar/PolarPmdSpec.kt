package com.nakauri.hrmonitor.ble.polar

import java.util.UUID

/**
 * Polar Measurement Data (PMD) — proprietary GATT service the Polar H10
 * (and Verity Sense, H13, etc.) expose for raw sensor streams. Documented
 * in the SDK repo: https://github.com/polarofficial/polar-ble-sdk
 *
 * Service is present only on firmware >= ~3.0. If the characteristic
 * discovery doesn't find it, the strap can still deliver HR + RR via the
 * standard Bluetooth HRS (0x180D / 0x2A37); PMD is additive.
 *
 * The client must enable notifications on BOTH the control-point (CP) and
 * data-stream (DATA) characteristics before writing a start command to CP.
 * Writing too soon (<200 ms after CCCDs) returns INVALID_STATE.
 */
object PolarPmdSpec {
    val PMD_SERVICE: UUID = UUID.fromString("fb005c80-02e7-f387-1cad-8acd2d8df0c8")
    val PMD_CONTROL_POINT: UUID = UUID.fromString("fb005c81-02e7-f387-1cad-8acd2d8df0c8")
    val PMD_DATA_STREAM: UUID = UUID.fromString("fb005c82-02e7-f387-1cad-8acd2d8df0c8")

    // Control-point op codes (PmdControlPointCommand.kt in the SDK).
    const val OP_GET_MEASUREMENT_SETTINGS: Byte = 0x01
    const val OP_REQUEST_MEASUREMENT_START: Byte = 0x02
    const val OP_STOP_MEASUREMENT: Byte = 0x03
    const val OP_GET_MEASUREMENT_STATUS: Byte = 0x05

    // Measurement type (PmdMeasurementType.kt).
    const val TYPE_ECG: Byte = 0x00
    const val TYPE_ACC: Byte = 0x02
    const val TYPE_PPI: Byte = 0x03

    // Setting TLV types within a START request (PmdSetting.kt).
    const val SETTING_SAMPLE_RATE: Byte = 0x00
    const val SETTING_RESOLUTION: Byte = 0x01

    // Response codes (PmdControlPointResponse.kt).
    const val RESPONSE_HEADER: Byte = 0xF0.toByte()
    const val STATUS_SUCCESS: Byte = 0x00
    const val STATUS_ALREADY_IN_STATE: Byte = 0x06
    const val STATUS_INVALID_STATE: Byte = 0x0C

    // H10 ECG params — the only combo the strap supports.
    const val H10_SAMPLE_RATE_HZ: Int = 130
    const val H10_RESOLUTION_BITS: Int = 14

    /**
     * Polar epoch: 2000-01-01 00:00:00 UTC. All PMD timestamps are nanoseconds
     * since this reference. Delta to the Unix epoch (1970-01-01):
     */
    const val POLAR_EPOCH_UNIX_MS: Long = 946_684_800_000L
}
