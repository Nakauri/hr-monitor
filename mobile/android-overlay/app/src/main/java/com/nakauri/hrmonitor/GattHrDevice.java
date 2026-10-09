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

    private BluetoothGatt currentGatt;
    private BluetoothGattCharacteristic hrChar;
    // 2 consecutive CCCD failures on a bonded handle = stale bond; trigger removeBond.
    private int cccdAttempts = 0;
    private boolean usingBondedHandle = false;

    GattHrDevice(Context appCtx, BleScanner bleScanner) {
        this.appCtx = appCtx;
        this.bleScanner = bleScanner;
    }

    @Override
    public void setCallback(Callback cb) { this.cb = cb; }

    @Override
    @SuppressLint("MissingPermission")
    public boolean connect(String mac) throws Exception {
        BluetoothAdapter adapter = bleScanner.adapter();
        // Handle resolution: bond cache → scan cache → rescan → PUBLIC fallback.
        // Coospo straps advertise as RANDOM; PUBLIC fallback connects but never
        // delivers notifications. See docs/ble-connect.md.
        usingBondedHandle = false;
        BluetoothDevice device = bleScanner.findBondedDevice(mac);
        if (device != null) usingBondedHandle = true;
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
            Log.w(TAG, "connect: PUBLIC fallback for " + mac);
            device = adapter.getRemoteDevice(mac);
        }

        closeGattQuietly();
        // autoConnect=false joins existing ACL links; =true waits on advertisements.
        currentGatt = device.connectGatt(appCtx, false, gattCallback);
        return usingBondedHandle;
    }

    @Override
    @SuppressLint("MissingPermission")
    public void reconnect() {
        BluetoothGatt g = currentGatt;
        if (g == null) {
            fullReconnect();
            return;
        }
        try {
            Log.i(TAG, "GATT reconnect: gatt.connect()");
            g.connect();
        } catch (Throwable t) {
            Log.w(TAG, "gatt.connect() threw: " + t.getMessage());
            fullReconnect();
        }
    }

    @Override
    @SuppressLint("MissingPermission")
    public void fullReconnect() {
        BluetoothAdapter adapter = bleScanner.adapter();
        if (adapter == null) return;
        String mac = null;
        if (currentGatt != null && currentGatt.getDevice() != null) {
            mac = currentGatt.getDevice().getAddress();
        }
        if (mac == null) return;
        BluetoothDevice device = bleScanner.findBondedDevice(mac);
        if (device == null) device = bleScanner.findScannedDevice(mac);
        if (device == null) {
            try { device = adapter.getRemoteDevice(mac); } catch (Throwable ignored) {}
        }
        if (device == null) return;
        closeGattQuietly();
        try {
            currentGatt = device.connectGatt(appCtx, false, gattCallback);
        } catch (Throwable t) {
            Log.w(TAG, "fullReconnectGatt connectGatt failed: " + t.getMessage());
        }
    }

    @Override
    public void disconnect() { closeGattQuietly(); }

    @Override
    public void stopStreams() { /* GATT notifications end with the link */ }

    @Override
    public boolean hasHandle() { return currentGatt != null; }

    @Override
    public String address() {
        BluetoothGatt g = currentGatt;
        BluetoothDevice d = g != null ? g.getDevice() : null;
        return d != null ? d.getAddress() : null;
    }

    // Every link teardown ends the streams first.
    private void closeGattQuietly() {
        stopStreams();
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
            Callback c = cb;
            if (newState == BluetoothGatt.STATE_CONNECTED) {
                Log.i(TAG, "GATT connected");
                if (c != null) c.onLinkUp();
                gatt.discoverServices();
            } else if (newState == BluetoothGatt.STATE_DISCONNECTED) {
                Log.i(TAG, "GATT disconnected status=" + status);
                hrChar = null;
                if (c != null) c.onLinkDown(status);
            }
        }

        @Override
        @SuppressLint("MissingPermission")
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
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
            hrChar = svc.getCharacteristic(HR_MEASUREMENT);
            if (hrChar == null) {
                Log.w(TAG, "HR measurement characteristic missing");
                return;
            }
            cccdAttempts = 0;
            // "connected" CSV row + priority bump are deferred to onDescriptorWrite ack.
            gatt.setCharacteristicNotification(hrChar, true);
            BluetoothGattDescriptor desc = hrChar.getDescriptor(CCCD);
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
            if (!CCCD.equals(descriptor.getUuid())) return;
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
            if (!HR_MEASUREMENT.equals(ch.getUuid())) return;
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

    /** Matches hr_monitor.html parseHR offsets. */
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
