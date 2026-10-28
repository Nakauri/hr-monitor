package com.nakauri.hrmonitor;

// Strap and relay reconnect decisions. Pure Java: HrEngine posts, opens and logs; tests inject the jitter.
final class ReconnectPolicy {
    // Uniform in [0, 1), as Math.random.
    interface Jitter { double next(); }

    // GATT: 2, 4, 8, 16, 30 s, plus or minus 20%; past this many attempts a full reconnect rebuilds the gatt.
    static final long GATT_BASE_MS = 2_000L;
    static final long GATT_MAX_MS = 30_000L;
    static final int GATT_FULL_AFTER = 5;

    // Relay: 4, 8, 16, 32, 60 s, plus or minus 25%; the UI hears about it at exactly this attempt.
    static final long RELAY_BASE_MS = 2_000L;
    static final long RELAY_MAX_MS = 60_000L;
    static final int RELAY_NOTIFY_AFTER = 10;
    // Safety net under the backoff: down, no retry queued and no attempt for this long, so reopen once.
    static final long RELAY_WATCHDOG_MS = 120_000L;

    private final Jitter jitter;
    private int gattAttempts = 0;
    private int relayAttempts = 0;

    ReconnectPolicy(Jitter jitter) { this.jitter = jitter; }

    // Counts the attempt, then returns its delay.
    long nextGattDelayMs() {
        gattAttempts++;
        long base = Math.min(GATT_MAX_MS, GATT_BASE_MS * (1L << Math.min(gattAttempts - 1, 4)));
        return (long) (base * (1.0 + (jitter.next() * 0.4 - 0.2)));
    }
    int gattAttempts() { return gattAttempts; }
    boolean gattFullReconnect(boolean hasHandle) { return gattAttempts > GATT_FULL_AFTER || !hasHandle; }
    void gattReset() { gattAttempts = 0; }

    // Counts the attempt, then returns its delay.
    long nextRelayDelayMs() {
        relayAttempts++;
        long base = Math.min(RELAY_MAX_MS, RELAY_BASE_MS * (1L << Math.min(relayAttempts, 5)));
        double j = 1.0 + (jitter.next() * 0.5 - 0.25);
        return (long) (base * j);
    }
    int relayAttempts() { return relayAttempts; }
    boolean relayNotifyNow() { return relayAttempts == RELAY_NOTIFY_AFTER; }
    void relayReset() { relayAttempts = 0; }

    static boolean relayWatchdogDue(boolean broadcast, boolean hasKey, boolean live, boolean retryPending, long now, long lastOpenAtMs) {
        return broadcast && hasKey && !live && !retryPending && now - lastOpenAtMs >= RELAY_WATCHDOG_MS;
    }
}
