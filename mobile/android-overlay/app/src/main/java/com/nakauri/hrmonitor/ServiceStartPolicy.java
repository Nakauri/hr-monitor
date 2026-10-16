package com.nakauri.hrmonitor;

// NativeHrService start decisions and the only home of the notification text. Pure Java.
public final class ServiceStartPolicy {
    private ServiceStartPolicy() {}

    public static final String ORIGIN_ENGINE = "engine";
    public static final String ORIGIN_ALARM = "alarm";
    public static final String ORIGIN_WORKER = "worker";
    public static final String ORIGIN_REPLACED = "replaced";
    public static final String ORIGIN_STICKY = "sticky";
    // Engine-side origins: a plugin start, the app coming forward, the page's recovery resume.
    public static final String ORIGIN_START = "start";
    public static final String ORIGIN_APP = "app";
    public static final String ORIGIN_JS = "js";

    public enum Action {
        // A stop's upload worker runs and no newer session is live: its tail owns shutdown.
        TEARDOWN,
        // A live engine: hooks, wake lock per link state, alarm, onWake.
        ATTACH,
        // Prefs say live and nothing records: build the engine if needed and resume from prefs.
        RESUME,
        // Nothing to run: drop the alarm, wake lock and notification, stopSelf(startId).
        IDLE_STOP
    }

    // Same formula as the alarm receiver, the worker and status().
    public static boolean prefsLive(boolean sessionActive, boolean cleanlyStopped) {
        return sessionActive && !cleanlyStopped;
    }

    public static Action decide(String origin, boolean prefsLive, boolean engineActive, boolean stopTeardown) {
        if (engineActive) return Action.ATTACH;
        if (stopTeardown) return Action.TEARDOWN;
        if (prefsLive && !ORIGIN_ENGINE.equals(origin)) return Action.RESUME;
        return Action.IDLE_STOP;
    }

    // START_STICKY only while something records, and never for a session the no-sticky test switch names.
    public static boolean sticky(Action a, boolean noStickyTest) {
        return !noStickyTest && (a == Action.ATTACH || a == Action.RESUME);
    }

    public static final String REASON_AUTO_END = "auto_end";
    public static final String REASON_USER_STOP = "user_stop_button";

    // The live-Stop worker logs session_auto_end and posts ENDED only when its own claim won.
    public static boolean announceAutoEnd(boolean claimed, String reason) {
        return claimed && REASON_AUTO_END.equals(reason);
    }

    // Only the alarm's wake may end a session; opening the app never does.
    public static long autoEndBoundFor(String wakeOrigin, long boundMs) {
        return ORIGIN_ALARM.equals(wakeOrigin) ? boundMs : 0L;
    }

    // A stop's upload worker runs: the notification says so, whatever the engine state.
    public static LinkStatePolicy.State notificationState(boolean stopping, boolean engineActive, LinkStatePolicy.State engineState) {
        if (stopping) return LinkStatePolicy.State.STOPPING;
        return engineActive ? engineState : LinkStatePolicy.State.PRE_RESUME;
    }

    // A stale Stop that did not match keeps prefs live: the resume alarm stays.
    public static boolean staleStopCancelsAlarm(boolean prefsLiveAfterCommit) {
        return !prefsLiveAfterCommit;
    }

    // The live-Stop worker's tail: the wake lock goes unless a newer session owns it, claim won or lost;
    // the alarm goes only when this stop won.
    public static boolean releaseAfterLiveStop(boolean stopped, boolean newerLive, boolean otherTeardownRunning) {
        return !newerLive && (stopped || !otherTeardownRunning);
    }

    public static boolean cancelAlarmAfterLiveStop(boolean stopped, boolean newerLive) {
        return stopped && !newerLive;
    }

    // Stale prefs: resume only while the last sign of life (last HR, else the start) is within the
    // auto-end horizon; a clock that went backwards counts as fresh.
    public static boolean resumeAllowedByAge(long lastAliveMs, long sessionStartMs, long nowMs) {
        long anchor = Math.max(lastAliveMs, sessionStartMs);
        return nowMs - anchor <= LinkStatePolicy.AUTO_END_NOT_FOUND_MS;
    }

    public static long staleAgeMs(long lastAliveMs, long sessionStartMs, long nowMs) {
        return Math.max(0L, nowMs - Math.max(lastAliveMs, sessionStartMs));
    }

    // A declined resume drops the alarm only when prefs are not live; error and stopping keep it for the next try.
    public static boolean resumeDeclineCancelsAlarm(String reason) {
        return "not_live".equals(reason);
    }

    // 43200000 -> "12", 1800000 -> "0.5".
    public static String hoursLabel(long ms) {
        return java.math.BigDecimal.valueOf(ms).divide(java.math.BigDecimal.valueOf(3_600_000L), 3, java.math.RoundingMode.HALF_UP)
            .stripTrailingZeros().toPlainString();
    }

    // The ENDED text names the bound the auto-end used.
    public static String[] endedText(long autoEndMs) {
        String h = hoursLabel(autoEndMs);
        return new String[] { "HR Monitor", "Ended after " + h + " h without the strap" };
    }

    // 4320000 -> "1h 12m", 720000 -> "12m"; whole minutes, rounded down.
    public static String minutesLabel(long ms) {
        long m = Math.max(0L, ms) / 60_000L;
        return m < 60L ? m + "m" : (m / 60L) + "h " + (m % 60L) + "m";
    }

    // {title, body}. hr <= 0 means no reading yet; rmssd null means none. Searching says Reconnecting until the auto-end.
    public static String[] text(LinkStatePolicy.State state, int hr, Double rmssd, long elapsedMs) {
        String title = "HR Monitor";
        switch (state) {
            case RECORDING:
                if (hr > 0) title = "HR " + hr + " bpm" + (rmssd != null ? " · HRV " + Math.round(rmssd) + "ms" : "");
                return new String[] { title, "Live · " + minutesLabel(elapsedMs) };
            case RECONNECTING:
            case NOT_FOUND:
                return new String[] { title, "Reconnecting" };
            case ENDED:
                return endedText(LinkStatePolicy.AUTO_END_NOT_FOUND_MS);
            case STOPPING:
                return new String[] { title, "Saving" };
            case RESUMING:
            case PRE_RESUME:
            default:
                return new String[] { title, "Resuming" };
        }
    }

    // The notification's Symptom action writes only into a live session.
    public static boolean symptomWrites(boolean engineNonNull, boolean sessionActive) {
        return engineNonNull && sessionActive;
    }

    // A second Symptom tap this soon after a write is the same symptom.
    public static final long SYMPTOM_DEBOUNCE_MS = 2_000L;

    public static boolean symptomDebounced(long lastWriteMs, long nowMs) {
        return lastWriteMs > 0L && nowMs >= lastWriteMs && nowMs - lastWriteMs < SYMPTOM_DEBOUNCE_MS;
    }

    // Symptom shows while the session is live, the strap off included.
    public static boolean showSymptom(LinkStatePolicy.State s) {
        return s == LinkStatePolicy.State.RECORDING || s == LinkStatePolicy.State.RECONNECTING
            || s == LinkStatePolicy.State.NOT_FOUND;
    }

    // The engine reads the notification predicate needs; null means no engine.
    public interface SymptomView {
        boolean isSessionActive();
        boolean isStopTeardownInProgress();
        LinkStatePolicy.State linkState();
    }

    // The notification carries Symptom; never throws, false on any failure.
    public static boolean symptomShown(SymptomView e) {
        try {
            return e != null && e.isSessionActive() && !e.isStopTeardownInProgress() && showSymptom(e.linkState());
        } catch (Throwable t) {
            return false;
        }
    }
}
