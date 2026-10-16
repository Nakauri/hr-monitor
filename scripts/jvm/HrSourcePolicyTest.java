import com.nakauri.hrmonitor.HrDecode;
import com.nakauri.hrmonitor.HrSourcePolicy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

// S54: the real HrSourcePolicy over the shared synthetic vectors. Checks shown, source, switched, newRun and the estimate
// against the golden file and every assertion line (J3), RR arrays untouched (J4), the copied GattHrDevice decoder (J2),
// and switched and newRun against source changes and marks (J6).
// Run through scripts/jvm/run-hr-source-test.cjs. Args: <vectors file> <golden file>. Exit 1 on any FAIL.
public class HrSourcePolicyTest {
    static int fails = 0, goldFails = 0, j2Fails = 0, j4Fails = 0, j6Fails = 0;
    static void fail(String m) { fails++; System.out.println("FAIL " + m); }
    static void goldFail(String m) { fails++; if (++goldFails <= 3) System.out.println("FAIL " + m); }

    static byte[] hex(String s) {
        byte[] b = new byte[s.length() / 2];
        for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return b;
    }

    public static void main(String[] args) throws Exception {
        List<String> vec = Files.readAllLines(Paths.get(args[0]), StandardCharsets.UTF_8);
        Map<String, String> gold = new HashMap<>();
        for (String l : Files.readAllLines(Paths.get(args[1]), StandardCharsets.UTF_8)) {
            String[] f = l.trim().split(" ");
            if (f.length == 7) gold.put(f[0] + " " + f[1], String.join(" ", Arrays.copyOfRange(f, 2, 7)));
        }
        String name = null;
        HrSourcePolicy p = null;
        List<int[]> res = new ArrayList<>(); // {shown, beat ? 1 : 0}
        boolean mark = false;
        int packets = 0, asserts = 0, cases = 0;
        for (String raw : vec) {
            String l = raw.trim();
            if (l.isEmpty() || l.startsWith("#")) continue;
            String[] f = l.split("\\s+");
            switch (f[0]) {
                case "case": name = f[1]; p = new HrSourcePolicy(); res = new ArrayList<>(); cases++; break;
                case "reset": p.reset(); mark = true; break;
                case "link": p.linkLive(); mark = true; break;
                case "p": {
                    int idx = res.size();
                    long t = Long.parseLong(f[1]);
                    int hr = Integer.parseInt(f[3]);
                    int[] rr;
                    if (f[4].equals("-")) rr = new int[0];
                    else { String[] s = f[4].split(";"); rr = new int[s.length]; for (int i = 0; i < s.length; i++) rr[i] = Integer.parseInt(s[i]); }
                    byte[] bytes = hex(f[2]);
                    int dHr = HrDecode.decodeHr(bytes);
                    int[] dRr = HrDecode.decodeRr(bytes);
                    if (dHr != hr || !Arrays.equals(dRr, rr)) {
                        if (j2Fails++ == 0) fail(name + " " + idx + " J2 decode " + dHr + " " + Arrays.toString(dRr) + " line " + hr + " " + Arrays.toString(rr));
                        else fails++;
                    }
                    int[] copy = rr.clone();
                    HrSourcePolicy.Result r = p.onPacket(hr, copy, t);
                    if (!Arrays.equals(copy, rr)) { if (j4Fails++ == 0) fail(name + " " + idx + " J4 rr changed"); else fails++; }
                    String got = r.shownHr + " " + (r.beat ? "B" : "S") + " " + r.switched + " " + (r.newRun ? 1 : 0) + " " + (Double.isNaN(r.beatHr) ? "-" : String.valueOf(Math.round(r.beatHr * 100)));
                    String want = gold.get(name + " " + idx);
                    if (!got.equals(want)) goldFail(name + " " + idx + " golden " + want + " java " + got);
                    boolean prev = idx > 0 && res.get(idx - 1)[1] == 1;
                    int wantSw = r.beat && !prev ? 1 : !r.beat && prev && !r.newRun ? -1 : 0;
                    if (r.switched != wantSw || ((idx == 0 || mark) && !r.newRun)) {
                        if (j6Fails++ == 0) fail(name + " " + idx + " J6 switched " + r.switched + " want " + wantSw + " newRun " + r.newRun);
                        else fails++;
                    }
                    mark = false;
                    res.add(new int[] { r.shownHr, r.beat ? 1 : 0 });
                    packets++;
                    break;
                }
                case "a": {
                    asserts++;
                    if (f[1].equals("switches")) {
                        int sw = 0;
                        for (int i = 0; i < res.size(); i++) if (res.get(i)[1] == 1 && (i == 0 || res.get(i - 1)[1] == 0)) sw++;
                        if (sw > Integer.parseInt(f[2])) fail(name + " switches " + sw + " > " + f[2]);
                        break;
                    }
                    int from = Integer.parseInt(f[1]), to = Integer.parseInt(f[2]);
                    for (int i = from; i <= to; i++) {
                        if (i >= res.size()) { fail(name + " " + i + " missing"); break; }
                        int[] r = res.get(i);
                        if (f[3].equals("src") && (r[1] == 1) != f[4].equals("B")) { fail(name + " " + i + " src " + (r[1] == 1 ? "B" : "S") + " want " + f[4]); break; }
                        if (f[3].equals("shown") && (r[0] < Integer.parseInt(f[4]) || r[0] > Integer.parseInt(f[5]))) { fail(name + " " + i + " shown " + r[0] + " want " + f[4] + ".." + f[5]); break; }
                    }
                    break;
                }
                default: fail("unknown line " + l);
            }
        }
        if (packets != gold.size()) fail("golden rows " + gold.size() + " packets " + packets);
        System.out.println("HrSourcePolicyTest: " + cases + " cases, " + packets + " packets, " + asserts + " assertions, " + fails + " failure(s)");
        System.exit(fails == 0 ? 0 : 1);
    }
}
