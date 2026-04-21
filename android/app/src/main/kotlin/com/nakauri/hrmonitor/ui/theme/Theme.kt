package com.nakauri.hrmonitor.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * Palette pulled from `index.html` / `hr_monitor.html` / `widget.css` so the
 * Android surfaces and the web surfaces look like the same product.
 *
 *   bg      #0a0a0a   (near-black background)
 *   panel   #101010   (card surface)
 *   border  #1f1f1f
 *   text    #d8d8d8
 *   dim     #8a8a8a
 *   accent-hr     #E88464   (big HR number, coral-orange)
 *   accent-rmssd  #5DCAA5   (RMSSD, mint green)
 *
 * Force-dark: the site never has a light mode and the ask is visual parity.
 * Dynamic colour is disabled for the same reason; dynamic wallpaper-derived
 * hues override the brand on Android 12+ otherwise.
 */
object BrandColors {
    val Background = Color(0xFF0A0A0A)
    val Surface = Color(0xFF101010)
    val SurfaceVariant = Color(0xFF1F1F1F)
    val OnSurface = Color(0xFFD8D8D8)
    val OnSurfaceDim = Color(0xFF8A8A8A)
    val AccentHr = Color(0xFFE88464)
    val AccentRmssd = Color(0xFF5DCAA5)
    val AccentWarm = Color(0xFFE89858)
}

/**
 * Desktop / web palette usage:
 *   - #5DCAA5 (accent-rmssd, mint green) is THE primary brand accent —
 *     card accent lines, the session-viewer "∿" mark, tab indicators,
 *     `apk-version.fresh` state, most interactive highlights.
 *   - #E88464 / #E89858 (accent-hr / accent-warm) is reserved for the
 *     big HR number inside the widget and the landing page's · dot.
 *     It's an accent, not a theme colour.
 *
 * Android mistake on the first pass: I wired primary = AccentHr, which
 * made every Material component default to salmon (buttons, switches,
 * selection, ripple, surface tint). That's why the app looked salmon-
 * washed. Correct wiring: primary = AccentRmssd for everything Material
 * touches, and only the HR number + HR-stage chips use AccentHr
 * explicitly.
 */
private val BrandDark = darkColorScheme(
    primary = BrandColors.AccentRmssd,
    onPrimary = Color(0xFF08201A),
    primaryContainer = Color(0xFF142822),
    onPrimaryContainer = BrandColors.OnSurface,

    secondary = BrandColors.AccentHr,
    onSecondary = Color(0xFF1A0E0B),
    secondaryContainer = Color(0xFF2A1612),
    onSecondaryContainer = BrandColors.OnSurface,

    tertiary = BrandColors.AccentWarm,
    onTertiary = Color(0xFF1A0F05),

    background = BrandColors.Background,
    onBackground = BrandColors.OnSurface,

    surface = BrandColors.Surface,
    onSurface = BrandColors.OnSurface,
    surfaceVariant = BrandColors.SurfaceVariant,
    onSurfaceVariant = BrandColors.OnSurfaceDim,
    surfaceTint = BrandColors.AccentRmssd,
    inverseSurface = BrandColors.OnSurface,
    inverseOnSurface = BrandColors.Background,
    inversePrimary = BrandColors.AccentRmssd,

    outline = BrandColors.SurfaceVariant,
    outlineVariant = Color(0xFF2A2A2A),

    error = Color(0xFFE04848),
    onError = Color(0xFF1A0808),
    errorContainer = Color(0xFF2A0F0F),
    onErrorContainer = BrandColors.OnSurface,

    scrim = Color(0xFF000000),
)

@Composable
fun HRMonitorTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = BrandDark, content = content)
}
