package com.nakauri.hrmonitor.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import com.nakauri.hrmonitor.session.SessionState

/**
 * 45-second scrolling HR trace. Mirrors the `inline-live-trace` Chart.js
 * canvas on the desktop widget but lighter — plain polyline, no axes, no
 * grid. The vertical range is auto-scaled to the min/max of the window
 * with 5 bpm padding so short flat traces don't glue to an axis.
 *
 * The line colour is the current HR-stage colour so the widget's
 * visual language matches the pips + big number.
 */
@Composable
fun LiveTrace(
    points: List<SessionState.HrPoint>,
    windowMs: Long,
    lineColor: Color,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier = modifier.fillMaxSize()) {
        if (points.size < 2) return@Canvas
        val now = points.last().timestampMs
        val start = now - windowMs

        val values = points.map { it.hrBpm }
        val min = (values.min() - 5).coerceAtLeast(30)
        val max = (values.max() + 5).coerceAtMost(220)
        val range = (max - min).coerceAtLeast(1)

        val w = size.width
        val h = size.height

        val path = Path()
        var drawn = 0
        for (p in points) {
            if (p.timestampMs < start) continue
            val tFrac = (p.timestampMs - start).toFloat() / windowMs.toFloat()
            val x = tFrac.coerceIn(0f, 1f) * w
            val vFrac = (p.hrBpm - min).toFloat() / range.toFloat()
            val y = h - (vFrac.coerceIn(0f, 1f) * h)
            if (drawn == 0) path.moveTo(x, y) else path.lineTo(x, y)
            drawn += 1
        }
        if (drawn < 2) return@Canvas

        drawPath(
            path = path,
            color = lineColor,
            style = Stroke(
                width = 2.5f,
                cap = StrokeCap.Round,
                join = StrokeJoin.Round,
            ),
        )

        // Small filled dot at the right edge — the "now" indicator, mirrors
        // how the desktop overlay anchors the eye to the latest beat.
        val last = points.last()
        val lastFrac = (last.hrBpm - min).toFloat() / range.toFloat()
        val lastY = h - (lastFrac.coerceIn(0f, 1f) * h)
        drawCircle(
            color = lineColor,
            radius = 4f,
            center = Offset(w - 2f, lastY),
        )
    }
}
