import com.nakauri.hrmonitor.LinkStatePolicy;
import com.nakauri.hrmonitor.LinkStatePolicy.State;
import com.nakauri.hrmonitor.ServiceStartPolicy;
import com.nakauri.hrmonitor.ServiceStartPolicy.Action;
import com.nakauri.hrmonitor.SessionGate;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

// Engine step 2 policies: the Service start table, the START_LOCK protocol, link states, auto-end, texts.
// Run through scripts/jvm/run-engine2-test.cjs (plain JDK 21, no Gradle, no Android).
public class ServiceStartPolicyTest {
    static int failures = 0;
    static int passes = 0;

    static void check(String name, boolean ok) {
        if (ok) passes++; else failures++;
        System.out.println((ok ? "  ok    " : "  FAIL  ") + name);
    }

    static final String[] ORIGINS = { "engine", "alarm", "worker", "replaced", "sticky" };
    static final String[] NON_ENGINE = { "alarm", "worker", "replaced", "sticky" };

    public static void main(String[] args) throws Exception {
        decideTable();
        lockInterleaveStopAfterClaim();
        lockInterleaveStopFirst();
        reviewBatch();
        auditBatch();
        linkStates();
        autoEnd();
        texts();
        System.out.println("\n" + passes + " passed, " + failures + " failed");
        System.exit(failures == 0 ? 0 : 1);
    }

    static void decideTable() {
        System.out.println("2.4 table");
        boolean attach = true;
        for (String o : ORIGINS) for (boolean live : new boolean[] { true, false }) for (boolean td : new boolean[] { true, false }) {
            Action a = ServiceStartPolicy.decide(o, live, true, td);
            attach &= a == Action.ATTACH && ServiceStartPolicy.sticky(a, false);
        }
        check("engine active: ATTACH, sticky, for every origin (a newer session during a teardown included)", attach);
        boolean resume = true;
        for (String o : NON_ENGINE) {
            Action a = ServiceStartPolicy.decide(o, true, false, false);
            resume &= a == Action.RESUME && ServiceStartPolicy.sticky(a, false);
        }
        check("prefs live, engine idle or absent, origin != engine: RESUME, sticky", resume);
        boolean teardown = true;
        for (String o : ORIGINS) {
            Action a = ServiceStartPolicy.decide(o, true, false, true);
            teardown &= a == Action.TEARDOWN && !ServiceStartPolicy.sticky(a, false);
        }
        check("prefs live plus stop teardown: TEARDOWN, NOT_STICKY, no resume", teardown);
        Action eng = ServiceStartPolicy.decide("engine", false, false, false);
        check("[S3] origin=engine, no active engine, prefs not live: IDLE_STOP, NOT_STICKY",
            eng == Action.IDLE_STOP && !ServiceStartPolicy.sticky(eng, false));
        Action engLive = ServiceStartPolicy.decide("engine", true, false, false);
        check("[S3] origin=engine never resumes, even with prefs live", engLive == Action.IDLE_STOP);
        // A user stop and an A8 stale-match commit both leave sessionActive=false, cleanlyStopped=true.
        boolean idle = true;
        boolean afterStop = ServiceStartPolicy.prefsLive(false, true);
        for (String o : ORIGINS) idle &= ServiceStartPolicy.decide(o, afterStop, false, false) == Action.IDLE_STOP;
        check("[S10] after a user stop or a stale-match commit, every origin idle-stops", !afterStop && idle);
        check("prefsLive = sessionActive && !cleanlyStopped",
            ServiceStartPolicy.prefsLive(true, false) && !ServiceStartPolicy.prefsLive(true, true)
                && !ServiceStartPolicy.prefsLive(false, false));
        check("[S9] the no-sticky test switch makes ATTACH and RESUME NOT_STICKY",
            !ServiceStartPolicy.sticky(Action.ATTACH, true) && !ServiceStartPolicy.sticky(Action.RESUME, true));
    }

    // Thread A resumes and parks between its claim and its prefs commit; thread B's Stop must wait, then go live.
    static void lockInterleaveStopAfterClaim() throws Exception {
        System.out.println("[S1] interleave: Stop lands while a resume holds its claim");
        Object lock = new Object();
        SessionGate gate = new SessionGate(lock);
        AtomicBoolean active = new AtomicBoolean(false);
        AtomicBoolean prefsLive = new AtomicBoolean(true);
        List<String> order = Collections.synchronizedList(new ArrayList<>());
        CountDownLatch claimed = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicReference<String> aResult = new AtomicReference<>();
        Thread a = new Thread(() -> {
            try {
                aResult.set(gate.resume(active::get, prefsLive::get, () -> false,
                    () -> "already", () -> "not_live", () -> "stopping",
                    () -> {
                        active.set(true);
                        order.add("A-claim");
                        claimed.countDown();
                        release.await(5, TimeUnit.SECONDS);
                        prefsLive.set(true);
                        order.add("A-commit");
                        return "resumed";
                    }));
            } catch (Exception e) { aResult.set("threw " + e); }
        }, "A-resume");
        a.start();
        claimed.await(5, TimeUnit.SECONDS);
        AtomicReference<SessionGate.StopPath> bPath = new AtomicReference<>();
        Thread b = new Thread(() -> bPath.set(gate.stop(active::get, () -> false,
            () -> { order.add("B-live"); active.set(false); prefsLive.set(false); },
            () -> { order.add("B-stale"); prefsLive.set(false); })), "B-stop");
        b.start();
        Thread.sleep(300);
        boolean blocked = b.getState() == Thread.State.BLOCKED && !order.contains("B-live") && !order.contains("B-stale");
        release.countDown();
        a.join(5000);
        b.join(5000);
        check("B blocks while A holds the claim", blocked);
        check("order is A-claim, A-commit, B-live", String.join(",", order).equals("A-claim,A-commit,B-live"));
        check("A resumed; B took the live branch", "resumed".equals(aResult.get()) && bPath.get() == SessionGate.StopPath.LIVE);
        check("the session ends stopped: prefs not live, engine idle", !prefsLive.get() && !active.get());
    }

    static void lockInterleaveStopFirst() throws Exception {
        System.out.println("[S1] interleave: Stop first, then the resume re-reads prefs");
        SessionGate gate = new SessionGate(new Object());
        AtomicBoolean active = new AtomicBoolean(false);
        AtomicBoolean prefsLive = new AtomicBoolean(true);
        SessionGate.StopPath p = gate.stop(active::get, () -> false, () -> active.set(false), () -> prefsLive.set(false));
        String r = gate.resume(active::get, prefsLive::get, () -> false,
            () -> "already", () -> "not_live", () -> "stopping", () -> { active.set(true); return "resumed"; });
        check("stale Stop commits, then the resume returns not_live", p == SessionGate.StopPath.STALE && "not_live".equals(r) && !active.get());
        AtomicBoolean live2 = new AtomicBoolean(true);
        String s = gate.resume(() -> false, live2::get, () -> true, () -> "already", () -> "not_live", () -> "stopping", () -> "resumed");
        check("a stop worker still tearing down: the resume returns stopping", "stopping".equals(s));
        String t = gate.resume(() -> true, live2::get, () -> false, () -> "already", () -> "not_live", () -> "stopping", () -> "resumed");
        check("an active engine: the resume returns alreadyRunning", "already".equals(t));
        check("teardown with no live session: TEARDOWN, no stale commit",
            gate.stop(() -> false, () -> true, () -> {}, () -> { throw new AssertionError("stale ran"); }) == SessionGate.StopPath.TEARDOWN);
    }

    static void linkStates() {
        System.out.println("link states");
        long t0 = 1_000_000L;
        LinkStatePolicy p = new LinkStatePolicy();
        p.onResume(t0);
        check("resume starts in RESUMING", p.state() == State.RESUMING);
        LinkStatePolicy.Transition tr = p.onHr(t0 + 5_000L);
        check("RESUMING to RECORDING on HR", tr != null && tr.from == State.RESUMING && tr.to == State.RECORDING);
        tr = p.onLinkDown(t0 + 6_000L);
        check("RECORDING to RECONNECTING on link down", tr != null && tr.to == State.RECONNECTING);
        long lastHr = t0 + 5_000L;
        check("still RECONNECTING one ms before 10 min", p.onTick(lastHr + LinkStatePolicy.STRAP_SEARCH_MS - 1) == null
            && p.state() == State.RECONNECTING);
        tr = p.onTick(lastHr + LinkStatePolicy.STRAP_SEARCH_MS);
        check("RECONNECTING to NOT_FOUND at 10 min exactly", tr != null && tr.to == State.NOT_FOUND);
        check("link down in NOT_FOUND stays NOT_FOUND", p.onLinkDown(lastHr + 700_000L) == null && p.state() == State.NOT_FOUND);
        tr = p.onHr(lastHr + 800_000L);
        check("NOT_FOUND to RECORDING on HR", tr != null && tr.from == State.NOT_FOUND && tr.to == State.RECORDING);
        LinkStatePolicy q = new LinkStatePolicy();
        q.onStart(t0);
        q.onHr(t0 + 1_000L);
        tr = q.onTick(t0 + 1_000L + LinkStatePolicy.HR_FRESH_MS + 1);
        check("RECORDING to RECONNECTING on stale HR", tr != null && tr.to == State.RECONNECTING);
        LinkStatePolicy r = new LinkStatePolicy();
        r.onResume(t0);
        check("RESUMING with no HR reaches NOT_FOUND at 10 min", r.onTick(t0 + LinkStatePolicy.STRAP_SEARCH_MS) != null && r.state() == State.NOT_FOUND);
        check("CPU held in RESUMING, RECORDING, RECONNECTING; released in NOT_FOUND",
            LinkStatePolicy.holdsCpu(State.RESUMING) && LinkStatePolicy.holdsCpu(State.RECORDING)
                && LinkStatePolicy.holdsCpu(State.RECONNECTING) && !LinkStatePolicy.holdsCpu(State.NOT_FOUND));
        check("[S5] heartbeat reconnects in every state but NOT_FOUND",
            LinkStatePolicy.heartbeatMayReconnect(State.RESUMING) && LinkStatePolicy.heartbeatMayReconnect(State.RECORDING)
                && LinkStatePolicy.heartbeatMayReconnect(State.RECONNECTING) && !LinkStatePolicy.heartbeatMayReconnect(State.NOT_FOUND));
        LinkStatePolicy w = new LinkStatePolicy();
        w.onStart(t0);
        check("a wake outside NOT_FOUND makes no attempt", !w.onWake(t0 + 1, LinkStatePolicy.AUTO_END_NOT_FOUND_MS).attempt);
    }

    static LinkStatePolicy notFoundAt(long t) {
        LinkStatePolicy p = new LinkStatePolicy();
        p.onResume(t - LinkStatePolicy.STRAP_SEARCH_MS);
        p.onTick(t);
        return p;
    }

    static void autoEnd() {
        System.out.println("[S15][T3] auto-end");
        long H12 = LinkStatePolicy.AUTO_END_NOT_FOUND_MS;
        check("AUTO_END_NOT_FOUND_MS is 12 h", H12 == 12L * 3_600_000L);
        long nf = 50_000_000L;
        LinkStatePolicy p = notFoundAt(nf);
        LinkStatePolicy.WakePlan early = p.onWake(nf + H12 - 1, H12);
        check("a wake before 12 h attempts without arming", early.attempt && !early.autoEnd && !p.onAttemptWindowEnd(nf + H12 - 1 + LinkStatePolicy.WAKE_ATTEMPT_MS));
        LinkStatePolicy.WakePlan w = p.onWake(nf + H12, H12);
        check("the wake crossing 12 h attempts the strap first and arms", w.attempt && w.autoEnd);
        p.onHr(nf + H12 + 20_000L);
        check("the attempt succeeds: RECORDING, nothing ends", p.state() == State.RECORDING && !p.onAttemptWindowEnd(nf + H12 + LinkStatePolicy.WAKE_ATTEMPT_MS));
        p.onTick(nf + H12 + 20_000L + LinkStatePolicy.STRAP_SEARCH_MS);
        LinkStatePolicy.WakePlan again = p.onWake(nf + H12 + 20_000L + LinkStatePolicy.STRAP_SEARCH_MS + 1, H12);
        check("any HR resets the 12 h clock", p.state() == State.NOT_FOUND && again.attempt && !again.autoEnd);
        LinkStatePolicy f = notFoundAt(nf);
        f.onWake(nf + H12 + 5, H12);
        long fEnd = nf + H12 + 5 + LinkStatePolicy.WAKE_ATTEMPT_MS;
        check("the attempt fails: liveStop is requested exactly once, at the window end",
            f.onAttemptWindowEnd(fEnd) && !f.onAttemptWindowEnd(fEnd + 1));
        LinkStatePolicy z = notFoundAt(nf);
        LinkStatePolicy.WakePlan zw = z.onWake(nf + 100L * 3_600_000L, 0L);
        check("constant 0 never ends", zw.attempt && !zw.autoEnd && !z.onAttemptWindowEnd(nf + 100L * 3_600_000L + LinkStatePolicy.WAKE_ATTEMPT_MS));
        check("liveStop that lost the claim to a user Stop: no auto-end line, no ENDED",
            !ServiceStartPolicy.announceAutoEnd(false, ServiceStartPolicy.REASON_AUTO_END));
        check("a user Stop that won its claim announces nothing",
            !ServiceStartPolicy.announceAutoEnd(true, ServiceStartPolicy.REASON_USER_STOP));
        check("the auto-end that won its claim announces", ServiceStartPolicy.announceAutoEnd(true, ServiceStartPolicy.REASON_AUTO_END));
        // Claim race: whoever flips the session first owns the stop.
        AtomicBoolean session = new AtomicBoolean(true);
        boolean userWon = session.compareAndSet(true, false);
        boolean autoWon = session.compareAndSet(true, false);
        check("user Stop first: the auto-end claim is lost and stays silent",
            userWon && !autoWon && !ServiceStartPolicy.announceAutoEnd(autoWon, ServiceStartPolicy.REASON_AUTO_END));
        check("hours label: 12 and 0.5", "12".equals(ServiceStartPolicy.hoursLabel(H12))
            && "0.5".equals(ServiceStartPolicy.hoursLabel(1_800_000L)));
    }

    // Review batch 2026-10-10: retry inside the wake window, alarm-only auto-end, STOPPING text,
    // stale-mismatch alarm, live-Stop wake-lock release, ENDED hours, inexact NOT_FOUND wording.
    static void reviewBatch() {
        System.out.println("review batch");
        long H12 = LinkStatePolicy.AUTO_END_NOT_FOUND_MS;
        long nf = 70_000_000L;
        long wake = nf + H12;
        LinkStatePolicy p = notFoundAt(nf);
        p.onWake(wake, H12);
        check("[1] a GATT failure 1 s into the window retries", p.shouldRetryAttempt(wake + 1_000L));
        check("[1] a failure inside the window never decides (no auto-end on one 133)", !p.onAttemptWindowEnd(wake + 1_000L));
        p.onHr(wake + 30_000L);
        check("[1] a retry that reaches the strap inside the window: RECORDING, nothing ends",
            p.state() == State.RECORDING && !p.onAttemptWindowEnd(wake + LinkStatePolicy.WAKE_ATTEMPT_MS));
        LinkStatePolicy q = notFoundAt(nf);
        q.onWake(wake, H12);
        check("[1] no retry once the window closes", !q.shouldRetryAttempt(wake + LinkStatePolicy.WAKE_ATTEMPT_MS));
        check("[1] the window end decides the armed auto-end", q.onAttemptWindowEnd(wake + LinkStatePolicy.WAKE_ATTEMPT_MS));
        check("[1] the window is 40 s", LinkStatePolicy.WAKE_ATTEMPT_MS == 40_000L);
        check("[6] only an alarm wake carries the auto-end bound",
            ServiceStartPolicy.autoEndBoundFor(ServiceStartPolicy.ORIGIN_ALARM, H12) == H12
                && ServiceStartPolicy.autoEndBoundFor(ServiceStartPolicy.ORIGIN_APP, H12) == 0L);
        LinkStatePolicy r = notFoundAt(nf);
        LinkStatePolicy.WakePlan app = r.onWake(wake + 1, ServiceStartPolicy.autoEndBoundFor(ServiceStartPolicy.ORIGIN_APP, H12));
        check("[6] opening the app past 12 h attempts but never arms",
            app.attempt && !app.autoEnd && !r.onAttemptWindowEnd(wake + 1 + LinkStatePolicy.WAKE_ATTEMPT_MS));
        check("[2] a running stop shows STOPPING whatever the engine says",
            ServiceStartPolicy.notificationState(true, false, State.PRE_RESUME) == State.STOPPING
                && ServiceStartPolicy.notificationState(true, true, State.RECORDING) == State.STOPPING);
        check("[2] no stop: the engine state, else PRE_RESUME",
            ServiceStartPolicy.notificationState(false, true, State.NOT_FOUND) == State.NOT_FOUND
                && ServiceStartPolicy.notificationState(false, false, State.RECORDING) == State.PRE_RESUME);
        check("[2] STOPPING text", eq(ServiceStartPolicy.text(State.STOPPING, 0, null, 0), "HR Monitor", "Saving your session."));
        check("[3] a stale Stop that left prefs live keeps the alarm",
            !ServiceStartPolicy.staleStopCancelsAlarm(true) && ServiceStartPolicy.staleStopCancelsAlarm(false));
        check("[4] a live Stop that lost its claim still releases the wake lock (no newer session)",
            ServiceStartPolicy.releaseAfterLiveStop(false, false, false) && ServiceStartPolicy.releaseAfterLiveStop(true, false, false)
                && !ServiceStartPolicy.releaseAfterLiveStop(false, true, false));
        check("[4] the alarm goes only when this stop won and no newer session runs",
            ServiceStartPolicy.cancelAlarmAfterLiveStop(true, false) && !ServiceStartPolicy.cancelAlarmAfterLiveStop(false, false)
                && !ServiceStartPolicy.cancelAlarmAfterLiveStop(true, true));
        check("[nit] ENDED names the bound used", eq(ServiceStartPolicy.endedText(1_800_000L), "HR Monitor",
            "Session ended after 0.5 hours without the strap.")
            && eq(ServiceStartPolicy.endedText(H12), "HR Monitor", "Session ended after 12 hours without the strap."));
        String[] inexact = ServiceStartPolicy.text(State.NOT_FOUND, 0, null, 0, false);
        check("[nit] inexact alarm: NOT_FOUND names no 10-minute interval", !inexact[1].contains("10 minutes")
            && ServiceStartPolicy.text(State.NOT_FOUND, 0, null, 0, true)[1].contains("every 10 minutes"));
    }

    // Audit batch 2026-10-10: stale-prefs age gate (R3), declined-resume alarm, teardown-aware release.
    static void auditBatch() {
        System.out.println("audit batch");
        long H12 = LinkStatePolicy.AUTO_END_NOT_FOUND_MS;
        long now = 2_000_000_000_000L;
        check("[R3] last sign of life 11 h ago resumes", ServiceStartPolicy.resumeAllowedByAge(now - 11L * 3_600_000L, now - 20L * 3_600_000L, now));
        check("[R3] exactly 12 h resumes; 12 h plus 1 ms does not",
            ServiceStartPolicy.resumeAllowedByAge(now - H12, 0L, now) && !ServiceStartPolicy.resumeAllowedByAge(now - H12 - 1, 0L, now));
        check("[R3] days-old prefs (an upgrade over a dead session) never resume",
            !ServiceStartPolicy.resumeAllowedByAge(now - 3L * 24L * 3_600_000L, now - 4L * 24L * 3_600_000L, now));
        check("[R3] no HR yet: the start time is the anchor", ServiceStartPolicy.resumeAllowedByAge(0L, now - 60_000L, now)
            && !ServiceStartPolicy.resumeAllowedByAge(0L, now - H12 - 60_000L, now));
        check("[R3] no anchor at all never resumes", !ServiceStartPolicy.resumeAllowedByAge(0L, 0L, now));
        check("[R3] a clock that went backwards counts as fresh", ServiceStartPolicy.resumeAllowedByAge(now + 3_600_000L, 0L, now));
        check("[R3] stale age for the log", ServiceStartPolicy.staleAgeMs(now - 30L * 3_600_000L, 0L, now) == 30L * 3_600_000L
            && "30".equals(ServiceStartPolicy.hoursLabel(ServiceStartPolicy.staleAgeMs(now - 30L * 3_600_000L, 0L, now))));
        check("[nit] a declined resume drops the alarm only for not_live",
            ServiceStartPolicy.resumeDeclineCancelsAlarm("not_live") && !ServiceStartPolicy.resumeDeclineCancelsAlarm("stopping")
                && !ServiceStartPolicy.resumeDeclineCancelsAlarm("error"));
        check("[nit] a lost claim keeps the lock while another stop's upload runs",
            !ServiceStartPolicy.releaseAfterLiveStop(false, false, true) && ServiceStartPolicy.releaseAfterLiveStop(true, false, true));
    }

    static void texts() {
        System.out.println("[S2] notification text");
        String[] rec = ServiceStartPolicy.text(State.RECORDING, 82, 41.2, 754_000L);
        check("RECORDING: HR 82 bpm · HRV 41ms / Recording · 12:34",
            "HR 82 bpm · HRV 41ms".equals(rec[0]) && "Recording · 12:34".equals(rec[1]));
        check("PRE_RESUME", eq(ServiceStartPolicy.text(State.PRE_RESUME, 0, null, 0), "HR Monitor", "Resuming your session."));
        check("RESUMING", eq(ServiceStartPolicy.text(State.RESUMING, 0, null, 0), "HR Monitor", "Resuming your session. Connecting to the strap."));
        check("RECONNECTING", eq(ServiceStartPolicy.text(State.RECONNECTING, 80, null, 0), "HR Monitor", "Strap disconnected. Reconnecting."));
        check("NOT_FOUND", eq(ServiceStartPolicy.text(State.NOT_FOUND, 80, null, 0), "HR Monitor", "Strap not found. Trying again every 10 minutes."));
        check("ENDED", eq(ServiceStartPolicy.text(State.ENDED, 0, null, 0), "HR Monitor", "Session ended after 12 hours without the strap."));
        boolean onlyRecording = true;
        boolean noDash = true;
        for (State s : State.values()) {
            String[] t = ServiceStartPolicy.text(s, 80, 40.0, 60_000L);
            String both = t[0] + " " + t[1];
            if (s != State.RECORDING && both.contains("Recording")) onlyRecording = false;
            if (both.contains("—") || both.contains("–") || both.contains(" - ")) noDash = false;
        }
        check("no state but RECORDING says Recording", onlyRecording);
        check("no dashes in any notification text", noDash);
    }

    static boolean eq(String[] t, String title, String body) { return title.equals(t[0]) && body.equals(t[1]); }
}
