package com.nakauri.hrmonitor;

// S15a pure parts of PdfPrinter: page geometry, memory budget, page count, file name.
// Run through scripts/jvm/run-pdf-test.cjs (plain JDK 21, no Gradle, no Android).
public class PdfPlanTest {
    static int failures = 0;
    static int passes = 0;
    static final long MB = 1024L * 1024L;

    static void check(String name, boolean ok) {
        if (ok) passes++; else failures++;
        System.out.println((ok ? "  ok    " : "  FAIL  ") + name);
    }

    public static void main(String[] args) {
        geometry();
        budget();
        pages();
        names();
        System.out.println("\n" + passes + " passed, " + failures + " failed");
        System.exit(failures == 0 ? 0 : 1);
    }

    static void geometry() {
        check("portrait page is US Letter 612 x 792 pt", Plan.widthPt(false) == 612 && Plan.heightPt(false) == 792);
        check("landscape page is 792 x 612 pt", Plan.widthPt(true) == 792 && Plan.heightPt(true) == 612);
        check("portrait raster at 2x is 1224 x 1584 px", Plan.rasterW(false) == 1224 && Plan.rasterH(false) == 1584);
        check("landscape raster at 2x is 1584 x 1224 px", Plan.rasterW(true) == 1584 && Plan.rasterH(true) == 1224);
        check("one raster is 7,755,264 bytes", Plan.rasterBytes() == 7_755_264L);
        check("a 1224 x 1584 raster fits a portrait page", Plan.fits(1224, 1584, false));
        check("a 1584 x 1224 raster fits a landscape page", Plan.fits(1584, 1224, true));
        check("a landscape raster does not fit a portrait page", !Plan.fits(1584, 1224, false));
        check("a 1x raster does not fit", !Plan.fits(612, 792, false));
        check("an oversized raster does not fit", !Plan.fits(2448, 3168, false));
    }

    static void budget() {
        check("budget is 24 MB", Plan.BUDGET_BYTES == 24L * MB);
        check("budget holds three page rasters", Plan.BUDGET_BYTES >= 3L * Plan.rasterBytes());
        check("headroom = max - (total - free)", Plan.headroom(256 * MB, 100 * MB, 30 * MB) == 186 * MB);
        check("headroom of exactly 24 MB is enough", !Plan.heapLow(124 * MB, 100 * MB, 0));
        check("headroom one byte under 24 MB is low", Plan.heapLow(124 * MB - 1, 100 * MB, 0));
        check("free memory inside the heap counts as headroom", !Plan.heapLow(100 * MB, 100 * MB, 30 * MB));
        check("a nearly full heap is low", Plan.heapLow(256 * MB, 250 * MB, 1 * MB));
        long four = 4L * Plan.rasterBytes() + Plan.BUDGET_BYTES;
        check("system with room for 4 rasters plus budget is not low", !Plan.systemLow(false, 200 * MB + four, 200 * MB, 4));
        check("system one byte short for 4 rasters is low", Plan.systemLow(false, 200 * MB + four - 1, 200 * MB, 4));
        check("system lowMemory flag is low whatever the numbers", Plan.systemLow(true, 4000 * MB, 0, 1));
        check("system need grows with page count", !Plan.systemLow(false, 200 * MB + four, 200 * MB, 4)
            && Plan.systemLow(false, 200 * MB + four, 200 * MB, 5));
    }

    static void pages() {
        check("0 moments: 1 page", Plan.pageCount(0, false) == 1);
        check("1 moment: 2 pages", Plan.pageCount(1, false) == 2);
        check("2 moments: 2 pages", Plan.pageCount(2, false) == 2);
        check("3 moments: 3 pages", Plan.pageCount(3, false) == 3);
        check("5 moments: 4 pages", Plan.pageCount(5, false) == 4);
        check("6 moments (worst case): 4 pages", Plan.pageCount(6, false) == 4);
        check("9 moments are capped at 6: 4 pages", Plan.pageCount(9, false) == 4);
        check("negative moments: 1 page", Plan.pageCount(-3, false) == 1);
        check("week page adds one", Plan.pageCount(6, true) == 5 && Plan.pageCount(0, true) == 2);
        for (int m = 0; m <= 6; m++) {
            if (Plan.pageCount(m, false) != 1 + (int) Math.ceil(m / 2.0)) { check("1 + ceil(m/2) at m=" + m, false); return; }
        }
        check("1 + ceil(moments/2) for 0 to 6", true);
    }

    static void names() {
        check("plain name kept", Plan.safeName("aorti-report-2026-04-26.pdf").equals("aorti-report-2026-04-26.pdf"));
        check("missing .pdf added", Plan.safeName("report").equals("report.pdf"));
        check("upper .PDF normalised", Plan.safeName("Report.PDF").equals("Report.pdf"));
        check("path parts dropped", Plan.safeName("../../files/lifecycle.log").equals("lifecycle.log.pdf"));
        check("windows path parts dropped", Plan.safeName("a\\..\\b.pdf").equals("b.pdf"));
        check("leading dots dropped", Plan.safeName("..hidden.pdf").equals("hidden.pdf"));
        check("spaces and symbols become dashes", Plan.safeName("Day 26 Apr: HR.pdf").equals("Day-26-Apr--HR.pdf"));
        check("null and empty get the default", Plan.safeName(null).equals("aorti-report.pdf") && Plan.safeName("").equals("aorti-report.pdf"));
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 200; i++) sb.append('a');
        check("long names capped at 80 plus .pdf", Plan.safeName(sb.toString()).length() == 84);
    }
}
