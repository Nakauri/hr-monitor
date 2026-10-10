package com.nakauri.hrmonitor;

// The START_LOCK claim protocol. A resume re-reads prefs, claims and commits prefs inside one
// critical section; a notification Stop decides live or stale inside the same lock, so it can
// never land between a resume's claim and its prefs commit. Pure Java.
public final class SessionGate {
    public interface Probe { boolean get(); }
    public interface Step<T> { T run() throws Exception; }

    public enum StopPath { LIVE, TEARDOWN, STALE }

    private final Object lock;

    public SessionGate(Object lock) { this.lock = lock; }

    // Order: already active, prefs not live, a stop still tearing down, else the start body.
    public <T> T resume(Probe active, Probe prefsLive, Probe stopping,
            Step<T> already, Step<T> notLive, Step<T> stoppingResult, Step<T> start) throws Exception {
        synchronized (lock) {
            if (active.get()) return already.run();
            if (!prefsLive.get()) return notLive.run();
            if (stopping.get()) return stoppingResult.run();
            return start.run();
        }
    }

    public static StopPath stopPath(boolean active, boolean teardown) {
        if (active) return StopPath.LIVE;
        if (teardown) return StopPath.TEARDOWN;
        return StopPath.STALE;
    }

    // The notification Stop's decision and its branch body, under the lock.
    public StopPath stop(Probe active, Probe teardown, Runnable live, Runnable stale) {
        synchronized (lock) {
            StopPath p = stopPath(active.get(), teardown.get());
            if (p == StopPath.LIVE) live.run();
            else if (p == StopPath.STALE) stale.run();
            return p;
        }
    }
}
