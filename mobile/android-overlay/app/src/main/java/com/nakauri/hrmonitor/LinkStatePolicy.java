package com.nakauri.hrmonitor;

// Strap link state for a live session. Pure Java: the engine feeds it events and acts on the transitions.
public final class LinkStatePolicy {
    // STOPPING is notification-only: a stop's upload worker runs (the Service, never the engine, shows it).
    public enum State { PRE_RESUME, RESUMING, RECORDING, RECONNECTING, NOT_FOUND, ENDED, STOPPING }

    // HR this recent counts as recording.
    public static final long HR_FRESH_MS = 60_000L;
    // No HR for this long (from the last HR, or from the resume) gives up the in-process search.
    public static final long STRAP_SEARCH_MS = 10L * 60_000L;
    // Continuous NOT_FOUND for this long ends the session at the next failed wake attempt; 0 never ends.
    public static final long AUTO_END_NOT_FOUND_MS = 12L * 60L * 60_000L;

    public static final class Transition {
        public final State from;
        public final State to;
        Transition(State from, State to) { this.from = from; this.to = to; }
    }

    // A wake: one strap attempt in NOT_FOUND; autoEnd when this wake has crossed the auto-end bound.
    public static final class WakePlan {
        public final boolean attempt;
        public final boolean autoEnd;
        WakePlan(boolean attempt, boolean autoEnd) { this.attempt = attempt; this.autoEnd = autoEnd; }
    }

    private State state = State.PRE_RESUME;
    // Start of the current no-HR stretch: the last HR, or the start/resume when none came yet.
    private long searchFromMs;
    private long notFoundSinceMs;
    private boolean autoEndArmed;

    public synchronized State state() { return state; }

    public static boolean holdsCpu(State s) {
        return s != State.NOT_FOUND && s != State.ENDED && s != State.PRE_RESUME;
    }

    // The 15 s heartbeat may schedule reconnects only while the in-process search runs.
    public static boolean heartbeatMayReconnect(State s) {
        return s == State.RESUMING || s == State.RECORDING || s == State.RECONNECTING;
    }

    private Transition moveTo(State next) {
        if (next == state) return null;
        Transition t = new Transition(state, next);
        state = next;
        if (next != State.NOT_FOUND) autoEndArmed = false;
        return t;
    }

    // A fresh start counts as recording from its start; the stale check takes over after HR_FRESH_MS.
    public synchronized Transition onStart(long nowMs) {
        searchFromMs = nowMs;
        return moveTo(State.RECORDING);
    }

    public synchronized Transition onResume(long nowMs) {
        searchFromMs = nowMs;
        return moveTo(State.RESUMING);
    }

    public synchronized Transition onHr(long nowMs) {
        searchFromMs = nowMs;
        return moveTo(State.RECORDING);
    }

    public synchronized Transition onLinkDown(long nowMs) {
        if (state == State.RECORDING || state == State.RESUMING) return moveTo(State.RECONNECTING);
        return null;
    }

    // Heartbeat and wakes: stale HR, then the search bound.
    public synchronized Transition onTick(long nowMs) {
        if (state == State.RECORDING && nowMs - searchFromMs > HR_FRESH_MS) {
            Transition t = moveTo(State.RECONNECTING);
            Transition t2 = searchBound(nowMs);
            return t2 != null ? new Transition(t.from, t2.to) : t;
        }
        return searchBound(nowMs);
    }

    private Transition searchBound(long nowMs) {
        if ((state == State.RESUMING || state == State.RECONNECTING) && nowMs - searchFromMs >= STRAP_SEARCH_MS) {
            notFoundSinceMs = nowMs;
            return moveTo(State.NOT_FOUND);
        }
        return null;
    }

    public synchronized Transition onEnded() { return moveTo(State.ENDED); }

    public synchronized long notFoundSinceMs() { return notFoundSinceMs; }

    // In NOT_FOUND: one attempt window of WAKE_ATTEMPT_MS; arms the auto-end when the stretch has
    // reached autoEndMs (0 = never).
    public synchronized WakePlan onWake(long nowMs, long autoEndMs) {
        if (state != State.NOT_FOUND) return new WakePlan(false, false);
        autoEndArmed = autoEndMs > 0L && nowMs - notFoundSinceMs >= autoEndMs;
        attemptUntilMs = nowMs + WAKE_ATTEMPT_MS;
        return new WakePlan(true, autoEndArmed);
    }

    // A wake's strap attempt keeps retrying GATT failures (133 is common) until this window closes.
    public static final long WAKE_ATTEMPT_MS = 40_000L;
    private long attemptUntilMs;

    // A GATT or resolve failure inside the window retries; it never decides the attempt.
    public synchronized boolean shouldRetryAttempt(long nowMs) {
        return state == State.NOT_FOUND && nowMs < attemptUntilMs;
    }

    // Only the window's end decides: true exactly once when the armed auto-end should run.
    public synchronized boolean onAttemptWindowEnd(long nowMs) {
        if (nowMs < attemptUntilMs) return false;
        boolean due = autoEndArmed && state == State.NOT_FOUND;
        autoEndArmed = false;
        return due;
    }
}
