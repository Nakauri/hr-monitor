package com.nakauri.hrmonitor;

// Rules for what may reach Drive. Pure Java: the device reads live in DriveGate.
// Behaviour: scripts/jvm/DrivePolicyTest.java.
public final class DrivePolicy {
    // A finished session CSV over this size waits for an unmetered network.
    public static final long METERED_FULL_FILE_MAX = 2L * 1024L * 1024L;
    // A closed segment not on Drive this long after closing shows on the status line.
    public static final long BEHIND_MS = 30L * 60_000L;

    private DrivePolicy() { }

    public static boolean allowFullFile(long bytes, boolean metered, boolean paused) {
        if (paused) return false;
        return !metered || bytes <= METERED_FULL_FILE_MAX;
    }

    // oldestPendingMs is 0 when nothing is pending.
    public static boolean behind(long oldestPendingMs, long nowMs) {
        return oldestPendingMs > 0L && nowMs - oldestPendingMs >= BEHIND_MS;
    }
}
