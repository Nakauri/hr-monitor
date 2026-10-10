package com.nakauri.hrmonitor;

// One connected strap. The device owns the link mechanics; HrEngine owns reconnect policy.
public interface HrDevice {
    interface Callback {
        void onLinkUp();
        void onStreamsLive();
        void onLinkDown(int status);
        // tsMs is currentTimeMillis at receipt.
        void onHr(int hr, int[] rrMs, boolean contactOff, long tsMs);
        void onEcg(long tsMs, int[] microvolts);
        void onAcc(long tsMs, int[] xyzMilliG);
        void onError(String reason, boolean staleBondCleared);
    }

    // No bonded, cached or rescanned handle, and the PUBLIC fallback was not allowed.
    final class ResolveFailedException extends Exception {
        public ResolveFailedException(String mac) { super("resolve_fail " + mac); }
    }

    void setCallback(Callback cb);
    // Blocking handle resolution; returns true when the bonded handle was used. allowPublic=false
    // never falls back to a PUBLIC-address handle (it connects but never notifies) and throws instead.
    boolean connect(String mac, boolean allowPublic) throws Exception;
    void reconnect();
    // Rebuilds the link from the live handle; never a PUBLIC-address handle.
    void fullReconnect();
    void disconnect();
    // Ends data streams; runs before every link teardown, disconnect() included.
    void stopStreams();
    boolean hasHandle();
    // GATT link connected (a handle can exist while still connecting or pending).
    boolean isLinkUp();
    // Closes any handle, then leaves a background autoConnect handle on the bonded device; false when not bonded.
    boolean pendingConnect(String mac) throws Exception;
    String address();
}
