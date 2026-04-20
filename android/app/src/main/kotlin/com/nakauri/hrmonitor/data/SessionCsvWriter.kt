package com.nakauri.hrmonitor.data

import android.content.Context
import com.nakauri.hrmonitor.diag.HrmLog
import java.io.BufferedWriter
import java.io.File
import java.io.FileWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Writes a session CSV to app-internal storage in the exact schema the
 * web app's `buildSessionCSV()` produces, so the existing `hrv_viewer.html`
 * browses native-recorded sessions without any reader changes.
 *
 * Columns: `time_min, epoch_ms, hr_bpm, rmssd_ms, palpitation, event,
 * warning, connection, posture`.
 *
 * The native build only populates `time_min`, `epoch_ms`, `hr_bpm`,
 * `rmssd_ms`, `connection`; the rest are empty strings (palpitation and
 * warning detection haven't been ported). Empty columns are still written
 * so the row count matches header count and the viewer's column parser
 * doesn't mis-align.
 *
 * Files live at `context.filesDir/sessions/<filename>.csv`. Filename
 * matches `hrv_session_YYYY-MM-DDTHH-MM-SS.csv` (ISO with colons replaced).
 */
class SessionCsvWriter private constructor(
    val file: File,
    val startEpochMs: Long,
    private val writer: BufferedWriter,
) {
    fun appendHrRow(hr: Int, rmssdMs: Double?, timestampMs: Long) {
        val tMin = (timestampMs - startEpochMs).coerceAtLeast(0L) / 60_000.0
        val row = listOf(
            "%.4f".format(Locale.US, tMin),
            timestampMs.toString(),
            hr.toString(),
            rmssdMs?.let { "%.2f".format(Locale.US, it) } ?: "",
            "", // palpitation
            "", // event
            "", // warning
            "", // connection
            "", // posture
        )
        try {
            writer.write(row.joinToString(","))
            writer.newLine()
        } catch (e: Exception) {
            HrmLog.warn("csv", "Row write failed: ${e.message}")
        }
    }

    fun appendConnectionRow(connState: String, timestampMs: Long) {
        val tMin = (timestampMs - startEpochMs).coerceAtLeast(0L) / 60_000.0
        val row = listOf(
            "%.4f".format(Locale.US, tMin),
            timestampMs.toString(),
            "", "", "", "", "",
            connState,
            "",
        )
        try {
            writer.write(row.joinToString(","))
            writer.newLine()
        } catch (e: Exception) {
            HrmLog.warn("csv", "Connection row write failed: ${e.message}")
        }
    }

    fun flush() {
        try { writer.flush() } catch (_: Exception) { /* best-effort */ }
    }

    fun close() {
        try { writer.flush() } catch (_: Exception) { }
        try { writer.close() } catch (_: Exception) { }
        HrmLog.info("csv", "Session closed: ${file.name} (${file.length()} bytes)")
    }

    companion object {
        private const val HEADER =
            "time_min,epoch_ms,hr_bpm,rmssd_ms,palpitation,event,warning,connection,posture"

        fun open(context: Context, startEpochMs: Long): SessionCsvWriter {
            val dir = File(context.filesDir, "sessions").apply { mkdirs() }
            val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss", Locale.US).apply {
                timeZone = TimeZone.getDefault()
            }
            val filename = "hrv_session_${fmt.format(Date(startEpochMs))}.csv"
            val file = File(dir, filename)
            val writer = BufferedWriter(FileWriter(file, false))
            writer.write(HEADER)
            writer.newLine()
            HrmLog.info("csv", "Session opened: $filename")
            return SessionCsvWriter(file, startEpochMs, writer)
        }

        /** List completed session CSVs that have not yet been uploaded. */
        fun listPending(context: Context): List<File> {
            val dir = File(context.filesDir, "sessions")
            if (!dir.isDirectory) return emptyList()
            return dir.listFiles { f -> f.isFile && f.name.endsWith(".csv") }?.toList()
                ?: emptyList()
        }
    }
}
