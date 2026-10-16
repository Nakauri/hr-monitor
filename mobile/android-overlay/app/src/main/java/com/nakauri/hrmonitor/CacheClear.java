package com.nakauri.hrmonitor;

import java.io.File;
import java.util.Map;
import java.util.Set;

// Diagnostics "Clear cache" [ledger 24]: deletes only local CSVs Drive holds in full. No android.*.
// Behaviour: scripts/jvm/CacheClearTest.java.
public final class CacheClear {
    private CacheClear() {}

    // {deleted, kept}. driveMaxSizes null (no Drive, or Drive unreadable) deletes nothing.
    public static int[] run(File dir, Set<String> skip, Map<String, Long> driveMaxSizes) {
        int deleted = 0, kept = 0;
        File[] files = dir != null ? dir.listFiles() : null;
        if (files == null) return new int[] { 0, 0 };
        for (File f : files) {
            if (!f.isFile() || !f.getName().endsWith(".csv")) continue;
            if (skip != null && skip.contains(f.getName())) continue;
            if (driveMaxSizes != null && driveMaxSizes.containsKey(f.getName())
                && SegmentUploadPlan.legacyOnDrive(f.length(), driveMaxSizes.get(f.getName()))
                && f.delete()) {
                deleted++;
            } else {
                kept++;
            }
        }
        return new int[] { deleted, kept };
    }
}
