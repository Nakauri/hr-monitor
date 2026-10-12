// Guards: S25 bubble thrown off the screen edge (drag, rotation, size change). Files: FloatingOverlayService.java. Runtime: about 3 s via run-bubble-test.cjs.
package com.nakauri.hrmonitor;

// S25 pure part of FloatingOverlayService: the bubble position clamp.
// Run through scripts/jvm/run-bubble-test.cjs (plain JDK 21, no Gradle, no Android).
public class BubbleBoundsTest {
    static int failures = 0;
    static int passes = 0;

    static void check(String name, boolean ok) {
        if (ok) passes++; else failures++;
        System.out.println((ok ? "  ok    " : "  FAIL  ") + name);
    }

    static boolean at(int[] p, int x, int y) {
        return p[0] == x && p[1] == y;
    }

    public static void main(String[] args) {
        axis();
        place();
        rotation();
        System.out.println("\n" + passes + " passed, " + failures + " failed");
        System.exit(failures == 0 ? 0 : 1);
    }

    static void axis() {
        check("inside stays put", Bounds.clamp(300, 200, 1080) == 300);
        check("exactly at the far edge stays put", Bounds.clamp(880, 200, 1080) == 880);
        check("one pixel past the far edge comes back", Bounds.clamp(881, 200, 1080) == 880);
        check("far past the far edge sits at area minus size", Bounds.clamp(5000, 200, 1080) == 880);
        check("past the near edge sits at 0", Bounds.clamp(-150, 200, 1080) == 0);
        check("bubble larger than the area pins to 0", Bounds.clamp(40, 1200, 1080) == 0);
        check("bubble larger than the area pins to 0 from the negative side", Bounds.clamp(-40, 1200, 1080) == 0);
        check("bubble exactly the area size pins to 0", Bounds.clamp(10, 1080, 1080) == 0);
        check("unmeasured bubble (size 0) stays inside the area", Bounds.clamp(2000, 0, 1080) == 1080 && Bounds.clamp(-5, 0, 1080) == 0);
    }

    static void place() {
        int w = 220, h = 90, aw = 1080, ah = 2000;
        check("inside both axes stays put", at(Bounds.place(400, 700, w, h, aw, ah), 400, 700));
        check("past the left edge", at(Bounds.place(-300, 700, w, h, aw, ah), 0, 700));
        check("past the right edge", at(Bounds.place(1500, 700, w, h, aw, ah), 860, 700));
        check("past the top edge", at(Bounds.place(400, -80, w, h, aw, ah), 400, 0));
        check("past the bottom edge", at(Bounds.place(400, 2600, w, h, aw, ah), 400, 1910));
        check("past a corner clamps both axes", at(Bounds.place(-10, 9999, w, h, aw, ah), 0, 1910));
        check("bubble larger than the screen sits at the top-left", at(Bounds.place(300, 300, 1500, 2500, aw, ah), 0, 0));
        check("wide bubble on a narrow area keeps y", at(Bounds.place(300, 300, 1500, h, aw, ah), 0, 300));
    }

    static void rotation() {
        int w = 220, h = 90;
        // Portrait 1080 x 2000 near the bottom right, then the area swaps to 2000 x 1080.
        int[] portrait = Bounds.place(860, 1910, w, h, 1080, 2000);
        check("portrait bottom-right corner is valid", at(portrait, 860, 1910));
        int[] landscape = Bounds.place(portrait[0], portrait[1], w, h, 2000, 1080);
        check("after the swap x is kept, y comes back inside", at(landscape, 860, 990));
        check("after the swap the bubble is fully inside", landscape[0] + w <= 2000 && landscape[1] + h <= 1080);
        int[] back = Bounds.place(1700, 500, w, h, 1080, 2000);
        check("landscape far right swaps back inside portrait", at(back, 860, 500));
    }
}
