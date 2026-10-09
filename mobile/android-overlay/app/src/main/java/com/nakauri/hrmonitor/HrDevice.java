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

    void setCallback(Callback cb);
    // Blocking handle resolution; returns true when the bonded handle was used.
    boolean connect(String mac) throws Exception;
    void reconnect();
    void fullReconnect();
    void disconnect();
    // Ends data streams; runs before every link teardown, disconnect() included.
    void stopStreams();
    boolean hasHandle();
    String address();
}
