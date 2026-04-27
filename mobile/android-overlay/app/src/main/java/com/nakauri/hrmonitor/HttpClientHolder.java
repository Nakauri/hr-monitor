package com.nakauri.hrmonitor;

import okhttp3.OkHttpClient;
import java.util.concurrent.TimeUnit;

// Process-wide OkHttpClient singletons. http() for one-shot, webSocketClient()
// for long-lived sockets (shares the pool via newBuilder()).
public final class HttpClientHolder {
    private static volatile OkHttpClient base;
    private static volatile OkHttpClient ws;

    private HttpClientHolder() {}

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

    public static OkHttpClient webSocketClient() {
        OkHttpClient c = ws;
        if (c == null) {
            synchronized (HttpClientHolder.class) {
                c = ws;
                if (c == null) {
                    c = http().newBuilder()
                        // 60s is well below PartyKit/Cloudflare's ~100s idle timeout
                        // and 3× lighter on battery in Doze than 20s.
                        .pingInterval(60, TimeUnit.SECONDS)
                        .readTimeout(0, TimeUnit.SECONDS)
                        .build();
                    ws = c;
                }
            }
        }
        return c;
    }
}
