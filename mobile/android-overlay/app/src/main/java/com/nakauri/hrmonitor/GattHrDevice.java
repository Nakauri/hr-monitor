package com.nakauri.hrmonitor;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.content.Context;
import android.util.Log;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

// Standard BLE heart-rate strap over GATT (0x180D / 0x2A37).
public class GattHrDevice implements HrDevice {
    private static final String TAG = "NativeHrSession";

    private static final UUID HR_SERVICE = BleScanner.HR_SERVICE;
    private static final UUID HR_MEASUREMENT = UUID.fromString("00002a37-0000-1000-8000-00805f9b34fb");
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private final Context appCtx;
    private final BleScanner bleScanner;
    private volatile Callback cb;

    // Held across every close-and-replace, so a callback cannot run between connectGatt and the assignment.
    private final Object gattLock = new Object();
    // volatile: ioExecutor (connect), main (reconnect) and binder threads read it.
    private volatile BluetoothGatt currentGatt;
    private volatile boolean linkUp = false;
    private volatile BluetoothGattCharacteristic hrChar;
    // 2 consecutive CCCD failures on a bonded handle = stale bond; trigger removeBond.
    private volatile int cccdAttempts = 0;
    private volatile boolean usingBondedHandle = false;

    GattHrDevice(Context appCtx, BleScanner bleScanner) {
        this.appCtx = appCtx;
        this.bleScanner = bleScanner;
    }

    @Override
    public void setCallback(Callback cb) { this.cb = cb; }

    @Override
    @SuppressLint("MissingPermission")
    public boolean connect(String mac, boolean allowPublic) throws Exception {
        BluetoothAdapter adapter = bleScanner.adapter();
        // Handle resolution: bond cache → scan cache → rescan → PUBLIC fallback (JS connects only).
        // Coospo straps advertise as RANDOM; PUBLIC fallback connects but never
        // delivers notifications. See docs/ble-connect.md.
        BluetoothDevice device = bleScanner.findBondedDevice(mac);
        final boolean bonded = device != null;
        if (device == null) device = bleScanner.findScannedDevice(mac);
        if (device == null && bleScanner.hasScanner()) {
            try {
                bleScanner.rescanForMac(mac, 3000L);
                device = bleScanner.findScannedDevice(mac);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
            } catch (Throwable t) {
                Log.w(TAG, "rescanForMac threw: " + t.getMessage());
            }
        }
        if (device == null) {
            if (!allowPublic) {
                NativeHrService.logLifecycle(appCtx, "resolve_fail mac=" + last4(mac));
                throw new ResolveFailedException(last4(mac));
            }
            Log.w(TAG, "connect: PUBLIC fallback for " + mac);
            device = adapter.getRemoteDevice(mac);
        }

        synchronized (gattLock) {
            closeGattQuietly();
            usingBondedHandle = bonded;
            // autoConnect=false joins existing ACL links; =true waits on advertisements.
            currentGatt = device.connectGatt(appCtx, false, gattCallback);
        }
        return bonded;
    }

    static String last4(String mac) {
        if (mac == null) return "null";
        String m = mac.replace(":", "");
        return m.length() <= 4 ? m : m.substring(m.length() - 4);
    }

    @Override
    @SuppressLint("MissingPermission")
    public void reconnect() {
        boolean rebuild = false;
        synchronized (gattLock) {
            BluetoothGatt g = currentGatt;
            if (g == null) {
                rebuild = true;
            } else {
                try {
                    Log.i(TAG, "GATT reconnect: gatt.connect()");
                    g.connect();
                } catch (Throwable t) {
                    Log.w(TAG, "gatt.connect() threw: " + t.getMessage());
                    rebuild = true;
                }
            }
        }
        if (rebuild) fullReconnect();
    }

    @Override
    @SuppressLint("MissingPermission")
    public void fullReconnect() {
        BluetoothAdapter adapter = bleScanner.adapter();
        if (adapter == null) return;
        BluetoothGatt g = currentGatt;
        BluetoothDevice cur = g != null ? g.getDevice() : null;
        if (cur == null) return;
        String mac = cur.getAddress();
        if (mac == null) return;
        BluetoothDevice device = bleScanner.findBondedDevice(mac);
        if (device == null) device = bleScanner.findScannedDevice(mac);
        // Never getRemoteDevice (PUBLIC): the live handle keeps the address type it was resolved with.
        if (device == null) {
            NativeHrService.logLifecycle(appCtx, "full_reconnect_reuse mac=" + last4(mac));
            device = cur;
        }
        synchronized (gattLock) {
            // Another thread replaced or stopped this handle during the lookup; that one stands.
            if (currentGatt != g) return;
            closeGattQuietly();
            try {
                currentGatt = device.connectGatt(appCtx, false, gattCallback);
            } catch (Throwable t) {
                Log.w(TAG, "fullReconnectGatt connectGatt failed: " + t.getMessage());
            }
        }
    }

    // The bonded handle only: autoConnect on an unbonded random address is unreliable.
    @Override
    @SuppressLint("MissingPermission")
    public boolean pendingConnect(String mac) throws Exception {
        BluetoothDevice bonded = bleScanner.findBondedDevice(mac);
        if (bonded == null) return false;
        synchronized (gattLock) {
            closeGattQuietly();
            usingBondedHandle = true;
            // autoConnect=true waits on advertisements with no CPU held; it never fires while another app holds the strap.
            currentGatt = bonded.connectGatt(appCtx, true, gattCallback);
            return currentGatt != null;
        }
    }

    @Override
    public void disconnect() { closeGattQuietly(); }

    @Override
    public void stopStreams() { /* GATT notifications end with the link */ }

    @Override
    public boolean hasHandle() { return currentGatt != null; }

    @Override
    public boolean isLinkUp() { return linkUp && currentGatt != null; }

    @Override
    public String address() {
        BluetoothGatt g = currentGatt;
        BluetoothDevice d = g != null ? g.getDevice() : null;
        return d != null ? d.getAddress() : null;
    }

    // Every link teardown ends the streams first.
    private void closeGattQuietly() {
        stopStreams();
        synchronized (gattLock) {
            if (currentGatt != null) {
                StringBuilder sb = new StringBuilder("closeGattQuietly thread=" + Thread.currentThread().getName());
                StackTraceElement[] st = new Throwable().getStackTrace();
                for (int i = 0; i < Math.min(st.length, 8); i++) sb.append("\n  ").append(st[i].toString());
                Log.i(TAG, sb.toString());
                try { currentGatt.disconnect(); } catch (Exception ignored) {}
                try { currentGatt.close(); } catch (Exception ignored) {}
                currentGatt = null;
                hrChar = null;
            }
            linkUp = false;
        }
    }

    // True when this callback belongs to a handle already closed or replaced.
    private boolean isStale(BluetoothGatt gatt, String what) {
        synchronized (gattLock) {
            if (gatt == currentGatt) return false;
        }
        NativeHrService.logLifecycle(appCtx, "gatt_stale_event what=" + what);
        return true;
    }

    // removeBond is hidden API; reflection is the canonical workaround.
    @SuppressLint("MissingPermission")
    private boolean removeBondViaReflection(BluetoothDevice device) {
        if (device == null) return false;
        try {
            Method m = device.getClass().getMethod("removeBond");
            Object result = m.invoke(device);
            boolean ok = (result instanceof Boolean) && (Boolean) result;
            Log.i(TAG, "removeBond reflection: ok=" + ok + " mac=" + device.getAddress());
            return ok;
        } catch (Throwable t) {
            Log.w(TAG, "removeBond reflection failed: " + t.getMessage());
            return false;
        }
    }

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        @SuppressLint("MissingPermission")
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            boolean stale;
            synchronized (gattLock) {
                stale = gatt != currentGatt;
                if (!stale && newState == BluetoothGatt.STATE_CONNECTED) linkUp = true;
                if (!stale && newState == BluetoothGatt.STATE_DISCONNECTED) { hrChar = null; linkUp = false; }
            }
            if (stale) {
                NativeHrService.logLifecycle(appCtx, "gatt_stale_event what=state" + newState);
                return;
            }
            Callback c = cb;
            if (newState == BluetoothGatt.STATE_CONNECTED) {
                Log.i(TAG, "GATT connected");
                if (c != null) c.onLinkUp();
                gatt.discoverServices();
            } else if (newState == BluetoothGatt.STATE_DISCONNECTED) {
                Log.i(TAG, "GATT disconnected status=" + status);
                if (c != null) c.onLinkDown(status);
            }
        }

        @Override
        @SuppressLint("MissingPermission")
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            if (isStale(gatt, "services")) return;
            if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.w(TAG, "Services discovery status=" + status);
                NativeHrService.logLifecycle(appCtx, "services_discovery_failed status=" + status);
                return;
            }
            android.bluetooth.BluetoothGattService svc = gatt.getService(HR_SERVICE);
            if (svc == null) {
                Log.w(TAG, "HR service not present");
                NativeHrService.logLifecycle(appCtx, "hr_service_missing");
                return;
            }
            BluetoothGattCharacteristic ch = svc.getCharacteristic(HR_MEASUREMENT);
            hrChar = ch;
            if (ch == null) {
                Log.w(TAG, "HR measurement characteristic missing");
                return;
            }
            cccdAttempts = 0;
            // "connected" CSV row + priority bump are deferred to onDescriptorWrite ack.
            gatt.setCharacteristicNotification(ch, true);
            BluetoothGattDescriptor desc = ch.getDescriptor(CCCD);
            if (desc != null) {
                desc.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                gatt.writeDescriptor(desc);
            } else {
                Log.w(TAG, "CCCD descriptor missing on HR characteristic");
            }
        }

        @Override
        @SuppressLint("MissingPermission")
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
            if (!CCCD.equals(descriptor.getUuid()) || isStale(gatt, "descriptor")) return;
            Callback c = cb;
            if (status == BluetoothGatt.GATT_SUCCESS) {
                Log.i(TAG, "CCCD write OK — notifications live");
                cccdAttempts = 0;
                if (c != null) c.onStreamsLive();
                try {
                    gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH);
                } catch (Throwable t) {
                    Log.w(TAG, "requestConnectionPriority failed: " + t.getMessage());
                }
                BluetoothDevice dev = gatt.getDevice();
                if (dev != null && dev.getBondState() == BluetoothDevice.BOND_NONE) {
                    try { dev.createBond(); }
                    catch (Throwable t) { Log.w(TAG, "createBond threw: " + t.getMessage()); }
                }
            } else {
                cccdAttempts++;
                if (cccdAttempts < 2) {
                    Log.w(TAG, "CCCD write FAILED status=" + status + " — retry " + cccdAttempts);
                    try {
                        descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                        gatt.writeDescriptor(descriptor);
                    } catch (Throwable t) {
                        Log.w(TAG, "CCCD retry threw: " + t.getMessage());
                    }
                } else {
                    Log.w(TAG, "CCCD failed twice. bondedHandle=" + usingBondedHandle);
                    if (usingBondedHandle && gatt.getDevice() != null
                        && gatt.getDevice().getBondState() == BluetoothDevice.BOND_BONDED) {
                        removeBondViaReflection(gatt.getDevice());
                    }
                    if (c != null) c.onError("cccd-failed", usingBondedHandle);
                }
            }
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic ch) {
            if (!HR_MEASUREMENT.equals(ch.getUuid()) || gatt != currentGatt) return;
            byte[] value = ch.getValue();
            if (value == null || value.length < 2) return;
            HrParse p = parseHrPacket(value);
            Callback c = cb;
            if (c != null) c.onHr(p.hr, p.rrMs, p.contactOff, System.currentTimeMillis());
        }
    };

    // ---- HR packet parsing ------------------------------------------------

    private static class HrParse {
        int hr;
        int[] rrMs;
        boolean contactOff;
    }

    /** Matches hr_monitor.html parseHR offsets; RR conversion matches hr-math.js rrMsFromRaw. */
    private static HrParse parseHrPacket(byte[] b) {
        HrParse out = new HrParse();
        int flags = b[0] & 0xff;
        boolean is16 = (flags & 0x01) != 0;
        boolean contactSupported = (flags & 0x04) != 0;
        boolean contactDetected = (flags & 0x02) != 0;
        boolean hasEnergy = (flags & 0x08) != 0;
        boolean hasRr = (flags & 0x10) != 0;
        out.contactOff = contactSupported && !contactDetected;

        int offset = 1;
        if (is16) {
            if (b.length < offset + 2) return out;
            int lo = b[offset] & 0xff;
            int hi = b[offset + 1] & 0xff;
            out.hr = (hi << 8) | lo;
            offset += 2;
        } else {
            if (b.length < offset + 1) return out;
            out.hr = b[offset] & 0xff;
            offset += 1;
        }
        if (hasEnergy) offset += 2;
        if (hasRr) {
            List<Integer> rrs = new ArrayList<>();
            while (b.length >= offset + 2) {
                int lo = b[offset] & 0xff;
                int hi = b[offset + 1] & 0xff;
                int raw = (hi << 8) | lo;
                rrs.add((int) Math.round(raw * 1000.0 / 1024.0)); // 1/1024 s → ms
                offset += 2;
            }
            int[] arr = new int[rrs.size()];
            for (int i = 0; i < rrs.size(); i++) arr[i] = rrs.get(i);
            out.rrMs = arr;
        }
        return out;
    }
}
