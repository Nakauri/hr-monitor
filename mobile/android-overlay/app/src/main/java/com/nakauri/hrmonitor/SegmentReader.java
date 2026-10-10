package com.nakauri.hrmonitor;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.regex.Matcher;

// Read side of the local v2 segments for the in-app viewer (B-b2). A segment is only ever read up to
// its last LF, so a row the writer is still producing never reaches a reader. The open segment's
// length is captured under the writer's lock (TeeSink.segmentReadableLength) and the read stops there.
// Pure Java: no android.* import. Behaviour: scripts/jvm/SegmentReaderTest.java.
public final class SegmentReader {
    // A recorded hour is about 75 KB; anything past this is read to its first MAX_READ_BYTES only.
    public static final int MAX_READ_BYTES = 2 * 1024 * 1024;

    private SegmentReader() {}

    public static final class Entry {
        public final String name;
        public final long base;
        public final long size;
        public final long mtime;
        public final boolean open;
        Entry(String name, long base, long size, long mtime, boolean open) {
            this.name = name; this.base = base; this.size = size; this.mtime = mtime; this.open = open;
        }
    }

    public static final class Read {
        public final String name;
        public final String text;
        // Bytes of text: the file up to its last LF within the captured length.
        public final long size;
        public final boolean open;
        public final boolean truncated;
        Read(String name, String text, long size, boolean open, boolean truncated) {
            this.name = name; this.text = text; this.size = size; this.open = open; this.truncated = truncated;
        }
    }

    // Answers for the open segment, under the writer's lock. readableLength returns -1 for any other name.
    public interface OpenSegment {
        String openName();
        long readableLength(String name);
    }

    // A whole-string v2 name match has no separator, so a request can never leave the segments folder.
    public static boolean validName(String name) {
        return name != null && SegmentWriter.NAME_PATTERN.matcher(name).matches();
    }

    // UTC hour start encoded in a valid name; Long.MIN_VALUE otherwise.
    public static long baseOf(String name) {
        if (name == null) return Long.MIN_VALUE;
        Matcher m = SegmentWriter.NAME_PATTERN.matcher(name);
        if (!m.matches()) return Long.MIN_VALUE;
        String d = m.group(1);
        java.util.Calendar c = java.util.Calendar.getInstance(TimeZone.getTimeZone("UTC"), Locale.US);
        c.clear();
        c.set(Integer.parseInt(d.substring(0, 4)), Integer.parseInt(d.substring(4, 6)) - 1,
            Integer.parseInt(d.substring(6, 8)), Integer.parseInt(m.group(2)), 0, 0);
        return c.getTimeInMillis();
    }

    // Segments whose hour starts in [hourStart(fromMs), toMs), oldest first. size is the last-LF length.
    public static List<Entry> list(File dir, long fromMs, long toMs, OpenSegment open) throws IOException {
        List<Entry> out = new ArrayList<>();
        String[] names = dir.list();
        if (names == null) return out;
        Arrays.sort(names);
        String openName = open != null ? open.openName() : null;
        long fromHour = fromMs == Long.MIN_VALUE ? Long.MIN_VALUE : SegmentWriter.hourStart(fromMs);
        for (String n : names) {
            if (!validName(n)) continue;
            long base = baseOf(n);
            if (base < fromHour || base >= toMs) continue;
            File f = new File(dir, n);
            if (!f.isFile()) continue;
            boolean isOpen = n.equals(openName);
            long cap = isOpen ? open.readableLength(n) : -1L;
            if (cap < 0) { isOpen = false; cap = f.length(); }
            out.add(new Entry(n, base, lastLfLength(f, cap), f.lastModified(), isOpen));
        }
        return out;
    }

    // One segment's text to its last LF. The open segment is read only to the length captured under the lock.
    public static Read read(File dir, String name, OpenSegment open, int maxBytes) throws IOException {
        if (!validName(name)) throw new IOException("bad_name");
        File f = new File(dir, name);
        if (!f.isFile()) throw new IOException("not_found");
        long cap = open != null ? open.readableLength(name) : -1L;
        boolean isOpen = cap >= 0;
        if (!isOpen) cap = f.length();
        boolean truncated = cap > maxBytes;
        int want = (int) Math.min(cap, (long) maxBytes);
        byte[] buf = new byte[want];
        int got = 0;
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            while (got < want) {
                int n = raf.read(buf, got, want - got);
                if (n < 0) break;
                got += n;
            }
        }
        int end = got;
        while (end > 0 && buf[end - 1] != '\n') end--;
        return new Read(name, new String(buf, 0, end, StandardCharsets.UTF_8), end, isOpen, truncated);
    }

    // Length of f up to and including its last LF within the first limit bytes; 0 when there is none.
    // One byte is read when the file ends in LF (every cleanly closed segment); the scan runs only otherwise.
    static long lastLfLength(File f, long limit) throws IOException {
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            long pos = Math.min(limit, raf.length());
            if (pos <= 0) return 0L;
            raf.seek(pos - 1);
            if (raf.read() == '\n') return pos;
            byte[] buf = new byte[4096];
            while (pos > 0) {
                int n = (int) Math.min(buf.length, pos);
                pos -= n;
                raf.seek(pos);
                raf.readFully(buf, 0, n);
                for (int i = n - 1; i >= 0; i--) if (buf[i] == '\n') return pos + i + 1;
            }
            return 0L;
        }
    }
}
