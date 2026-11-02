package com.nakauri.hrmonitor;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.LongSupplier;

import kotlin.ResultKt;
import kotlin.coroutines.Continuation;
import kotlin.coroutines.CoroutineContext;
import kotlin.coroutines.EmptyCoroutineContext;
import kotlin.coroutines.intrinsics.IntrinsicsKt;

/** Blocks the calling (non-main) thread on a Kotlin suspend function called from Java. */
@SuppressWarnings({"rawtypes", "unchecked"})
final class HcAwait implements Continuation {
    static final long TIMEOUT_MS = 20000L;
    // A timed-out read cannot be cancelled; its kind stays busy until the late result or this cap.
    static final long BUSY_CAP_MS = 120000L;

    interface SuspendCall { Object run(Continuation c) throws Exception; }

    final CompletableFuture<Object> future = new CompletableFuture<>();

    @Override public CoroutineContext getContext() { return EmptyCoroutineContext.INSTANCE; }

    @Override public void resumeWith(Object result) {
        try {
            ResultKt.throwOnFailure(result);
            future.complete(result);
        } catch (Throwable t) {
            future.completeExceptionally(t);
        }
    }

    /** One in-flight call per kind. A lease's token frees only its own slot, never a newer call's. */
    static final class Slots {
        private final LongSupplier clock;
        private final Map<String, long[]> held = new HashMap<>();
        private long next = 1;

        Slots(LongSupplier clock) { this.clock = clock; }

        synchronized Lease take(String kind) {
            long[] h = held.get(kind);
            long now = clock.getAsLong();
            if (h != null && now - h[1] < BUSY_CAP_MS) return null;
            long token = next++;
            held.put(kind, new long[] { token, now });
            return new Lease(this, kind, token);
        }

        synchronized void release(String kind, long token) {
            long[] h = held.get(kind);
            if (h != null && h[0] == token) held.remove(kind);
        }

        synchronized long current(String kind) {
            long[] h = held.get(kind);
            return h == null ? 0 : h[0];
        }
    }

    static final class Lease {
        final Slots slots;
        final String kind;
        final long token;
        volatile boolean late;

        Lease(Slots slots, String kind, long token) { this.slots = slots; this.kind = kind; this.token = token; }

        /** Frees the slot unless a timed-out call still holds it. */
        void close() { if (!late) slots.release(kind, token); }
    }

    static Object await(SuspendCall call, long timeoutMs) throws Throwable {
        return await(call, timeoutMs, null);
    }

    /** With a lease, a timeout keeps the slot until this call's late result arrives (or the cap passes). */
    static Object await(SuspendCall call, long timeoutMs, Lease lease) throws Throwable {
        HcAwait c = new HcAwait();
        Object r = call.run(c);
        if (r != IntrinsicsKt.getCOROUTINE_SUSPENDED()) return r;
        try {
            return c.future.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            if (lease != null) {
                lease.late = true;
                c.future.whenComplete((v, t) -> lease.slots.release(lease.kind, lease.token));
            }
            throw new Exception("hc_timeout");
        } catch (ExecutionException e) {
            throw e.getCause() != null ? e.getCause() : e;
        }
    }
}
