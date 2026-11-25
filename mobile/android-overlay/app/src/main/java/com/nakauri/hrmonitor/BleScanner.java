package com.nakauri.hrmonitor;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.content.Context;
import android.os.Handler;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;
import java.util.Set;
import java.util.UUID;

// Strap scanning and handle lookup; the adapter is shared with GattHrDevice.
public class BleScanner {
    private static final String TAG = "NativeHrSession";
    static final UUID HR_SERVICE = UUID.fromString("0000180d-0000-1000-8000-00805f9b34fb");


    private final Context appCtx;
    private BluetoothAdapter adapter;
    private volatile BluetoothLeScanner scanner;
    private final List<DiscoveredDevice> scanResults = new java.util.concurrent.CopyOnWriteArrayList<>();
    private ScanCallback scanCallback;

    BleScanner(Context appCtx) {
        this.appCtx = appCtx;
        BluetoothManager bm = (BluetoothManager) appCtx.getSystemService(Context.BLUETOOTH_SERVICE);
        if (bm != null) {
            adapter = bm.getAdapter();
            if (adapter != null) scanner = adapter.getBluetoothLeScanner();
        }
    }

    BluetoothAdapter adapter() { return adapter; }

    boolean hasScanner() { return liveScanner() != null; }

    // Android has no scanner while Bluetooth is off, so an app opened then fetches it once Bluetooth is on.
    private BluetoothLeScanner liveScanner() {
        if (scanner == null && adapter != null) {
            try { scanner = adapter.getBluetoothLeScanner(); } catch (Throwable t) { Log.w(TAG, "getBluetoothLeScanner: " + t.getMessage()); }
        }
        return scanner;
    }

    private void ensureScanCallback() {
        if (scanCallback == null) {
            scanCallback = new ScanCallback() {
                @Override
                public void onScanResult(int callbackType, ScanResult result) {
                    ingestScanResult(result);
                }
                @Override
                public void onScanFailed(int errorCode) {
                    Log.w(TAG, "Scan failed errorCode=" + errorCode);
                }
            };
        }
    }

    // One scan at a time; a new scan settles the previous one with its results so far.
    private final class ScanJob implements Runnable {
        final Handler handler;
        final OwnStrap own;
        final HrEngine.Done<JSONArray> done;
        boolean finished;
        ScanJob(Handler handler, OwnStrap own, HrEngine.Done<JSONArray> done) { this.handler = handler; this.own = own; this.done = done; }
        @Override public void run() { finishScan(this); }
    }

    private ScanJob pendingScan;

    // The strap aorti.ca holds itself, read when the scan ends; never shown as in use by another app.
    interface OwnStrap { String mac(); }

    @SuppressLint("MissingPermission")
    void scan(long timeoutMs, Handler handler, OwnStrap own, HrEngine.Done<JSONArray> done) {
        if (liveScanner() == null) { done.fail("Bluetooth unavailable"); return; }
        ScanJob prev;
        synchronized (this) { prev = pendingScan; pendingScan = null; }
        if (prev != null) {
            prev.handler.removeCallbacks(prev);
            finishScan(prev);
        }
        scanResults.clear();
        ensureScanCallback();
        ScanJob job = new ScanJob(handler, own, done);
        try {
            // Unfiltered — many straps (Coospo H808S included) advertise
            // 0x180D only in scan response, not the primary advertisement.
            // Filtering would miss them. Classify in ingestScanResult.
            scanner.startScan(scanCallback);
            synchronized (this) { pendingScan = job; }
            handler.postDelayed(job, timeoutMs);
        } catch (SecurityException e) {
            done.fail("BLUETOOTH_SCAN denied: " + e.getMessage());
        } catch (Throwable t) {
            // startScan throws IllegalStateException when Bluetooth is off; an escaped throw kills the process.
            NativeHrService.logLifecycle(appCtx, "scan_failed " + t.getClass().getSimpleName());
            done.fail("Bluetooth is off or unavailable");
        }
    }

    // A bonded device counts as HR only when its cached service UUIDs list 0x180D.
    @SuppressLint("MissingPermission")
    private static boolean hasHrUuid(BluetoothDevice b) {
        try {
            android.os.ParcelUuid[] uuids = b.getUuids();
            if (uuids == null) return false;
            for (android.os.ParcelUuid u : uuids) if (u != null && HR_SERVICE.equals(u.getUuid())) return true;
        } catch (Throwable ignored) {}
        return false;
    }

    @SuppressLint("MissingPermission")
    private static JSONObject unscanned(BluetoothDevice b, boolean bonded, boolean inUse) {
        String n = b.getName();
        JSONObject obj = new JSONObject();
        HrEngine.putSafe(obj, "mac", b.getAddress());
        HrEngine.putSafe(obj, "name", n != null ? n : b.getAddress());
        HrEngine.putSafe(obj, "rssi", -127);
        HrEngine.putSafe(obj, "isHr", hasHrUuid(b) || (!bonded && nameHints(n)));
        HrEngine.putSafe(obj, "bonded", bonded);
        HrEngine.putSafe(obj, "inUse", inUse);
        return obj;
    }

    // LE devices connected to this phone through another app, keyed by address; aorti.ca's own strap left out.
    @SuppressLint("MissingPermission")
    private java.util.Map<String, BluetoothDevice> heldByOthers(String ownMac) {
        java.util.Map<String, BluetoothDevice> m = new java.util.LinkedHashMap<>();
        try {
            BluetoothManager bm = (BluetoothManager) appCtx.getSystemService(Context.BLUETOOTH_SERVICE);
            if (bm == null) return m;
            for (BluetoothDevice b : bm.getConnectedDevices(BluetoothProfile.GATT)) {
                if (b == null || b.getAddress() == null) continue;
                if (ownMac != null && ownMac.equalsIgnoreCase(b.getAddress())) continue;
                m.put(b.getAddress(), b);
            }
        } catch (Throwable t) {
            Log.w(TAG, "connected enumeration failed: " + t.getMessage());
        }
        return m;
    }

    // Runs on the main looper for a timeout, where an escaped throw kills the process.
    @SuppressLint("MissingPermission")
    private void finishScan(ScanJob job) {
        synchronized (this) {
            if (job.finished) return;
            job.finished = true;
            if (pendingScan == job) pendingScan = null;
        }
        boolean settled = false;
        try {
            try { scanner.stopScan(scanCallback); } catch (Exception ignored) {}
            JSONArray arr = new JSONArray();
            java.util.Set<String> seen = new java.util.HashSet<>();
            String ownMac = null;
            try { ownMac = job.own != null ? job.own.mac() : null; } catch (Throwable t) { Log.w(TAG, "own strap: " + t.getMessage()); }
            java.util.Map<String, BluetoothDevice> held = heldByOthers(ownMac);
            for (DiscoveredDevice d : scanResults) {
                seen.add(d.mac);
                JSONObject obj = new JSONObject();
                HrEngine.putSafe(obj, "mac", d.mac);
                HrEngine.putSafe(obj, "name", d.name);
                HrEngine.putSafe(obj, "rssi", d.rssi);
                HrEngine.putSafe(obj, "isHr", d.isHr);
                HrEngine.putSafe(obj, "bonded", false);
                HrEngine.putSafe(obj, "inUse", held.containsKey(d.mac));
                arr.put(obj);
            }
            // Bonded BLE fallback: strap doesn't advertise while connected
            // to another app, so include every bonded LE device the scan missed.
            try {
                for (BluetoothDevice b : adapter.getBondedDevices()) {
                    if (seen.contains(b.getAddress())) continue;
                    int type = b.getType();
                    if (type == BluetoothDevice.DEVICE_TYPE_CLASSIC) continue;
                    seen.add(b.getAddress());
                    arr.put(unscanned(b, true, held.containsKey(b.getAddress())));
                }
            } catch (Throwable t) {
                Log.w(TAG, "bonded enumeration failed: " + t.getMessage());
            }
            // An unpaired strap another app holds stops advertising, so only this list finds it.
            // Its handle joins the scan cache so a tap connects with the strap's real address type.
            for (BluetoothDevice b : held.values()) {
                if (seen.contains(b.getAddress())) continue;
                seen.add(b.getAddress());
                JSONObject obj = unscanned(b, false, true);
                arr.put(obj);
                scanResults.add(new DiscoveredDevice(b.getAddress(), obj.optString("name", b.getAddress()), -127, obj.optBoolean("isHr"), b));
            }
            settled = true;
            job.done.ok(arr);
        } catch (Throwable t) {
            Log.w(TAG, "scan finish failed: " + t);
        } finally {
            if (!settled) {
                try { job.done.fail("internal"); }
                catch (Throwable t) { Log.w(TAG, "scan fail settle threw: " + t); }
            }
        }
    }

    @SuppressLint("MissingPermission")
    BluetoothDevice findBondedDevice(String mac) {
        if (adapter == null || mac == null) return null;
        try {
            Set<BluetoothDevice> bonded = adapter.getBondedDevices();
            if (bonded == null) return null;
            for (BluetoothDevice d : bonded) {
                if (mac.equalsIgnoreCase(d.getAddress())) return d;
            }
        } catch (SecurityException e) {
            Log.w(TAG, "getBondedDevices: " + e.getMessage());
        } catch (Throwable t) {
            Log.w(TAG, "findBondedDevice threw: " + t.getMessage());
        }
        return null;
    }

    BluetoothDevice findScannedDevice(String mac) {
        for (DiscoveredDevice d : scanResults) {
            if (d.mac.equals(mac)) return d.btDevice;
        }
        return null;
    }

    /**
     * Targeted scan to repopulate scanResults with a specific MAC, blocking
     * up to timeoutMs. Fires only when the cache is cold (process restart)
     * and the user is reconnecting via cached MAC. Re-uses the existing
     * scanCallback so ingestScanResult() de-dupes into scanResults.
     */
    @SuppressLint("MissingPermission")
    void rescanForMac(String mac, long timeoutMs) throws InterruptedException {
        if (liveScanner() == null) return;
        ensureScanCallback();
        // Filtered: with the screen off, Android 8.1+ returns nothing to an unfiltered scan.
        java.util.List<android.bluetooth.le.ScanFilter> filters = null;
        try {
            filters = java.util.Collections.singletonList(
                new android.bluetooth.le.ScanFilter.Builder().setDeviceAddress(mac.toUpperCase(java.util.Locale.US)).build());
        } catch (Throwable t) {
            Log.w(TAG, "rescanForMac: no MAC filter: " + t.getMessage());
        }
        try {
            if (filters != null) {
                scanner.startScan(filters, new android.bluetooth.le.ScanSettings.Builder().build(), scanCallback);
            } else {
                scanner.startScan(scanCallback);
            }
        } catch (SecurityException e) {
            Log.w(TAG, "rescanForMac: scan permission denied");
            return;
        } catch (Throwable t) {
            // startScan throws IllegalStateException with Bluetooth off.
            Log.w(TAG, "rescanForMac: startScan failed: " + t.getMessage());
            return;
        }
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (findScannedDevice(mac) != null) break;
            Thread.sleep(50);
        }
        try { scanner.stopScan(scanCallback); } catch (Throwable ignored) {}
    }

    private void ingestScanResult(ScanResult result) {
        if (result == null || result.getDevice() == null) return;
        BluetoothDevice device = result.getDevice();
        String mac = device.getAddress();
        if (mac == null) return;
        for (DiscoveredDevice d : scanResults) {
            if (d.mac.equals(mac)) return; // already seen
        }
        String name = null;
        if (result.getScanRecord() != null) name = result.getScanRecord().getDeviceName();
        if (name == null) {
            try { name = device.getName(); } catch (SecurityException ignored) {}
        }
        boolean hasHrService = false;
        if (result.getScanRecord() != null && result.getScanRecord().getServiceUuids() != null) {
            for (android.os.ParcelUuid u : result.getScanRecord().getServiceUuids()) {
                if (HR_SERVICE.equals(u.getUuid())) { hasHrService = true; break; }
            }
        }
        scanResults.add(new DiscoveredDevice(mac, name, result.getRssi(), hasHrService || nameHints(name), device));
    }

    // Strap makers' names, for a strap whose advert or cache lacks the HR service.
    private static boolean nameHints(String name) {
        if (name == null) return false;
        String u = name.toUpperCase(java.util.Locale.US);
        return u.contains("COOSPO") || u.contains("H808") || u.contains("POLAR") || u.contains("GARMIN")
            || u.contains("WAHOO") || u.contains("HRM") || u.contains("HEART") || u.startsWith("808S");
    }

    private static class DiscoveredDevice {
        final String mac;
        final String name;
        final int rssi;
        final boolean isHr;
        final BluetoothDevice btDevice;
        DiscoveredDevice(String mac, String name, int rssi, boolean isHr, BluetoothDevice device) {
            this.mac = mac; this.name = name; this.rssi = rssi; this.isHr = isHr; this.btDevice = device;
        }
    }
}
