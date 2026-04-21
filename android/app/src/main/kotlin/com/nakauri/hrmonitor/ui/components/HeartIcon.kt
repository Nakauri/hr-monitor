package com.nakauri.hrmonitor.ui.components

import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.scale

/**
 * The pulsing heart from the widget header. Matches the `@keyframes heartbeat`
 * in widget.css: 0/100 = 1.0, 15% = 1.18, 30% = 1.0, 45% = 1.12, 60% = 1.0.
 * Period is 1 s (the CSS animation duration).
 *
 * The SVG path is the Material "Favorite" glyph the desktop widget uses —
 * same path d attribute, converted to Compose Path via string parsing would
 * be overkill, so the shape is hand-transcribed below.
 */
@Composable
fun HeartIcon(
    color: Color,
    modifier: Modifier = Modifier,
    beatMs: Int = 1000,
) {
    val transition = rememberInfiniteTransition(label = "heartbeat")
    val scaleFrac by transition.animateFloat(
        initialValue = 1f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = keyframes {
                durationMillis = beatMs
                1.00f at 0 using LinearEasing
                1.18f at (beatMs * 15 / 100) using FastOutLinearInEasing
                1.00f at (beatMs * 30 / 100) using LinearEasing
                1.12f at (beatMs * 45 / 100) using FastOutLinearInEasing
                1.00f at (beatMs * 60 / 100) using LinearEasing
                1.00f at beatMs using LinearEasing
            }
        ),
        label = "heartScale",
    )

    Canvas(modifier = modifier) {
        scale(scaleFrac, scaleFrac) {
            val heart = Path().apply {
                // 24-unit viewport, same proportions as the Material Favorite glyph.
                val s = size.width / 24f
                moveTo(12f * s, 21.35f * s)
                relativeLineTo(-1.45f * s, -1.32f * s)
                relativeCubicTo(-5.15f * s, -4.67f * s, -8.55f * s, -7.75f * s, -8.55f * s, -11.53f * s)
                relativeCubicTo(0f, -3.08f * s, 2.42f * s, -5.5f * s, 5.5f * s, -5.5f * s)
                relativeCubicTo(1.74f * s, 0f, 3.41f * s, 0.81f * s, 4.5f * s, 2.09f * s)
                cubicTo(13.09f * s, 3.81f * s, 14.76f * s, 3f * s, 16.5f * s, 3f * s)
                cubicTo(19.58f * s, 3f * s, 22f * s, 5.42f * s, 22f * s, 8.5f * s)
                cubicTo(22f * s, 12.28f * s, 18.6f * s, 15.36f * s, 13.45f * s, 20.04f * s)
                lineTo(12f * s, 21.35f * s)
                close()
            }
            drawPath(path = heart, color = color)
        }
    }
}

