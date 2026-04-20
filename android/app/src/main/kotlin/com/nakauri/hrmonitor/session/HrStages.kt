package com.nakauri.hrmonitor.session

/**
 * Stage thresholds match the web app's default `colorThresholds`. The web
 * app lets the user override these in Settings and persists to localStorage;
 * Phase 5 here will pull overrides from Drive appData so the Android
 * publisher and web monitor classify identically.
 *
 * Stages are sent as strings ("stage-normal" etc.) so the overlay renders
 * the same colour classes as the web monitor.
 */
object HrStages {
    fun hrStage(hr: Int): String = when {
        hr < 60 -> "stage-low"
        hr < 100 -> "stage-normal"
        hr < 140 -> "stage-elevated"
        hr < 170 -> "stage-high"
        else -> "stage-critical"
    }

    fun rmssdStage(rmssd: Double): String = when {
        rmssd >= 40 -> "stage-normal"
        rmssd >= 25 -> "stage-elevated"
        rmssd >= 15 -> "stage-high"
        else -> "stage-critical"
    }
}
