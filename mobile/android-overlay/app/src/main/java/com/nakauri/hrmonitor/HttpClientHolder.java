package com.nakauri.hrmonitor;

import okhttp3.OkHttpClient;
import java.util.concurrent.TimeUnit;

/**
 * Single OkHttpClient for the whole process. OkHttp's docs are explicit
 * that one client should be shared across all uses: the connection pool,
 * thread dispatcher, and HTTP/2 multiplexing all benefit from it.
 *
 * The session plugin, relay socket plugin, Drive uploader, and auth
 * storage all needed their own clients before — four sets of pools and
 * dispatcher threads for what's effectively the same network behaviour.
 *
 * For sites that need WebSocket-specific config (relay socket: long
 * pingInterval + zero readTimeout), use {@link #webSocketClient()}; it
 * builds a new client on top of the shared pool, which is cheap.
 */
public final class HttpClientHolder {
    private static volatile OkHttpClient base;
    private static volatile OkHttpClient ws;

    private HttpClientHolder() {}

    /** Default client for one-shot HTTP requests (Drive, auth refresh). */
    public static OkHttpClient http() {
        OkHttpClient c = base;
        if (c == null) {
            synchronized (HttpClientHolder.class) {
                c = base;
                if (c == null) {
                    c = new OkHttpClient.Builder()
                        .connectTimeout(15, TimeUnit.SECONDS)
                        .readTimeout(60, TimeUnit.SECONDS)
                        .writeTimeout(60, TimeUnit.SECONDS)
                        .build();
                    base = c;
                }
            }
        }
        return c;
    }

    /**
     * Client tuned for long-lived WebSocket connections. Shares the same
     * connection pool + dispatcher as {@link #http()} via newBuilder().
     * Ping interval keeps the connection alive across NAT timeouts;
     * read timeout is zero because messages can arrive minutes apart.
     */
    public static OkHttpClient webSocketClient() {
        OkHttpClient c = ws;
        if (c == null) {
            synchronized (HttpClientHolder.class) {
                c = ws;
                if (c == null) {
                    c = http().newBuilder()
                        .pingInterval(20, TimeUnit.SECONDS)
                        .readTimeout(0, TimeUnit.SECONDS)
                        .build();
                    ws = c;
                }
            }
        }
        return c;
    }
}
