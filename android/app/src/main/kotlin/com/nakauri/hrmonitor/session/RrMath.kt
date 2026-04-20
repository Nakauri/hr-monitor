package com.nakauri.hrmonitor.session

import kotlin.math.sqrt

/**
 * Rolling RR-interval window for RMSSD computation.
 *
 * RMSSD = sqrt(mean(delta_i^2)) over successive RR interval differences.
 * Standard vagal tone proxy. The web app uses a 30-second window and drops
 * RRs older than that; we mirror that behaviour exactly so desktop overlay
 * values match the Android publisher.
 *
 * Thread-unsafe by design. Callers run this in a single coroutine context
 * (the session coordinator).
 */
class RrWindow(private val windowMs: Long = 30_000L) {
    private val entries: ArrayDeque<Entry> = ArrayDeque()

    fun add(rrMs: Int, timestampMs: Long) {
        entries.addLast(Entry(rrMs, timestampMs))
        prune(timestampMs)
    }

    fun addAll(rrList: List<Int>, timestampMs: Long) {
        for (rr in rrList) entries.addLast(Entry(rr, timestampMs))
        prune(timestampMs)
    }

    /** RMSSD in milliseconds, or null with fewer than 2 intervals. */
    fun rmssd(): Double? {
        if (entries.size < 2) return null
        var sumSq = 0.0
        var count = 0
        var prev = entries.first().rrMs
        val iter = entries.iterator()
        iter.next()
        while (iter.hasNext()) {
            val e = iter.next()
            val d = (e.rrMs - prev).toDouble()
            sumSq += d * d
            count += 1
            prev = e.rrMs
        }
        return if (count == 0) null else sqrt(sumSq / count)
    }

    fun size(): Int = entries.size

    fun clear() { entries.clear() }

    private fun prune(nowMs: Long) {
        val cutoff = nowMs - windowMs
        while (entries.isNotEmpty() && entries.first().timestampMs < cutoff) {
            entries.removeFirst()
        }
    }

    private data class Entry(val rrMs: Int, val timestampMs: Long)
}
