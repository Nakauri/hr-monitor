// ble-adapter.js — monkey-patches `navigator.bluetooth` to proxy to the
// Capacitor @capacitor-community/bluetooth-le plugin, so hr_monitor.html's
// existing Web Bluetooth code (requestDevice → gatt.connect → service →
// characteristic → startNotifications) runs unchanged on Android native.
//
// Important: we grab the plugin via Capacitor.registerPlugin which returns
// the RAW bridge handle, not the plugin's ESM wrapper. That means every
// call takes an options object (NOT positional args), binary values cross
// the bridge as base64 strings, and notifications arrive via addListener
// (not inline callbacks). We bridge both patterns to the shape Web
// Bluetooth wants on the JS side.

// Defer patching until DOMContentLoaded. Capacitor's bridge is guaranteed
// to be on window by then. We're registered from <head> so our listener
// fires before the main page's listener in hr_monitor.html — by the time
// that code checks navigator.bluetooth, our patch is in place.
try { window.__hrMonitorBleAdapterLoaded = true; } catch (e) {}

function whenReady(cb) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', cb, { once: true });
  } else {
    cb();
  }
}

function setMark(key, val) { try { window[key] = val; } catch (e) {} }

whenReady(function() {
  try {
    'use strict';
    setMark('__hrMonitorBleAdapterRanInit', true);
    const cap = window.Capacitor;
    setMark('__hrMonitorBleAdapterCapacitorAvailable', !!cap);
    if (!cap) {
      console.info('[ble-adapter] no Capacitor bridge — running as web, leaving navigator.bluetooth alone.');
      return;
    }
    const platform = cap.getPlatform ? cap.getPlatform() : 'unknown';
    setMark('__hrMonitorBleAdapterPlatform', platform);
    const isNative = cap.isNativePlatform && cap.isNativePlatform();
    setMark('__hrMonitorBleAdapterIsNative', !!isNative);
    if (!isNative) {
      console.info('[ble-adapter] Capacitor present but not native — skipping BLE patch.');
      return;
    }

    // Try the direct Plugins reference first — that's what Capacitor's
    // native bridge populates without any JS-side help. registerPlugin
    // is a JS-module-only API and doesn't exist on window.Capacitor
    // unless @capacitor/core is imported via ESM, which we don't do.
    let BleClient = (cap.Plugins && cap.Plugins.BluetoothLe) || null;
    if (!BleClient && typeof cap.registerPlugin === 'function') {
      try { BleClient = cap.registerPlugin('BluetoothLe'); }
      catch (e) {
        setMark('__hrMonitorBleAdapterLastError', 'registerPlugin threw: ' + (e && e.message ? e.message : String(e)));
      }
    }
    setMark('__hrMonitorBleAdapterGotPlugin', !!BleClient);
    if (!BleClient) {
      console.error('[ble-adapter] Capacitor BluetoothLe plugin missing — bail.');
      setMark('__hrMonitorBleAdapterLastError', (window.__hrMonitorBleAdapterLastError || '') + ' / Capacitor.Plugins.BluetoothLe undefined');
      return;
    }

  // Numeric shortcodes (0x180D, 0x2A37) → full 128-bit UUID. The plugin
  // requires the full form on Android.
  const toUuid = (shortcode) => {
    if (typeof shortcode === 'string') return shortcode.toLowerCase();
    const hex = shortcode.toString(16).padStart(4, '0');
    return `0000${hex}-0000-1000-8000-00805f9b34fb`;
  };

  // @capacitor-community/bluetooth-le serializes binary values across the
  // native bridge as HEX STRINGS (confirmed from plugin source:
  // convertValue() calls hexStringToDataView). Previously we assumed
  // base64, which gave garbage HR readings (30000 bpm etc). Spaces and
  // other separators sometimes appear; strip them defensively.
  function hexStringToDataView(hex) {
    if (!hex || typeof hex !== 'string') return new DataView(new ArrayBuffer(0));
    const clean = hex.replace(/[^0-9a-fA-F]/g, '');
    if (clean.length % 2 !== 0) return new DataView(new ArrayBuffer(0));
    const buf = new ArrayBuffer(clean.length / 2);
    const view = new Uint8Array(buf);
    for (let i = 0; i < clean.length; i += 2) {
      view[i / 2] = parseInt(clean.substr(i, 2), 16);
    }
    return new DataView(buf);
  }
  // Keep the old name as an alias so nothing else breaks if it's referenced.
  const b64ToDataView = hexStringToDataView;

  let bleInitialized = false;
  async function ensureBleReady() {
    if (bleInitialized) return;
    try {
      await BleClient.initialize({ androidNeverForLocation: true });
    } catch (e) {
      console.warn('[ble-adapter] initialize warning:', e);
    }
    try {
      await BleClient.requestEnable();
    } catch (e) { /* bluetooth already enabled, or user cancelled */ }
    bleInitialized = true;
  }

  function makeCharacteristic(deviceId, serviceUuid, charUuid) {
    const handlers = new Set();
    let subscribed = false;
    let pluginListener = null;

    return {
      uuid: charUuid,
      async startNotifications() {
        if (subscribed) return this;
        // Notifications arrive as plugin events, NOT as callbacks passed to
        // startNotifications. Event name is:
        //   notification|<deviceId>|<serviceUuid>|<characteristicUuid>
        // All UUIDs lowercase. Event payload is { value: <base64 bytes> }.
        const eventName = 'notification|' + deviceId + '|' + serviceUuid + '|' + charUuid;
        pluginListener = await BleClient.addListener(eventName, (ev) => {
          const dv = b64ToDataView(ev && ev.value);
          const wrapped = { target: { value: dv } };
          for (const h of handlers) { try { h(wrapped); } catch (e) { console.warn('[ble-adapter] notification handler threw:', e); } }
        });
        await BleClient.startNotifications({ deviceId, service: serviceUuid, characteristic: charUuid });
        subscribed = true;
        return this;
      },
      async stopNotifications() {
        if (!subscribed) return this;
        try { await BleClient.stopNotifications({ deviceId, service: serviceUuid, characteristic: charUuid }); } catch (e) {}
        if (pluginListener && typeof pluginListener.remove === 'function') {
          try { await pluginListener.remove(); } catch (e) {}
        }
        pluginListener = null;
        subscribed = false;
        return this;
      },
      async readValue() {
        const res = await BleClient.read({ deviceId, service: serviceUuid, characteristic: charUuid });
        return b64ToDataView(res && res.value);
      },
      addEventListener(name, handler) {
        if (name === 'characteristicvaluechanged') handlers.add(handler);
      },
      removeEventListener(name, handler) {
        if (name === 'characteristicvaluechanged') handlers.delete(handler);
      },
    };
  }

  function makeService(deviceId, serviceUuid) {
    return {
      uuid: serviceUuid,
      async getCharacteristic(charShortOrUuid) {
        return makeCharacteristic(deviceId, serviceUuid, toUuid(charShortOrUuid));
      },
    };
  }

  function makeDevice(info) {
    const disconnectHandlers = new Set();
    const deviceId = info.deviceId;
    let connected = false;
    let disconnectListener = null;

    const gatt = {
      get connected() { return connected; },
      async connect() {
        if (connected) return gatt;
        // Plugin fires 'disconnect|<deviceId>' when the device drops.
        const eventName = 'disconnect|' + deviceId;
        try {
          disconnectListener = await BleClient.addListener(eventName, () => {
            connected = false;
            for (const h of disconnectHandlers) { try { h({ target: device }); } catch (e) {} }
          });
        } catch (e) { /* non-fatal */ }
        await BleClient.connect({ deviceId });
        connected = true;
        return gatt;
      },
      async disconnect() {
        if (!connected) return;
        connected = false;
        if (disconnectListener && typeof disconnectListener.remove === 'function') {
          try { await disconnectListener.remove(); } catch (e) {}
          disconnectListener = null;
        }
        try { await BleClient.disconnect({ deviceId }); } catch (e) {}
      },
      async getPrimaryService(serviceShortOrUuid) {
        return makeService(deviceId, toUuid(serviceShortOrUuid));
      },
      // Non-standard extension: let hr_monitor.html ask for HIGH connection
      // priority after a successful connect. BALANCED is Android's default
      // (~50-100 ms interval), HIGH is ~11-15 ms — smoother tick cadence on
      // older phones and under load. Small strap-battery cost is fine for
      // the duration of a session.
      async _requestConnectionPriority(priority) {
        try {
          await BleClient.requestConnectionPriority({ deviceId, connectionPriority: priority || 'high' });
          return true;
        } catch (e) { console.warn('[ble-adapter] requestConnectionPriority failed:', e); return false; }
      },
    };

    const device = {
      id: deviceId,
      name: info.name || info.localName || null,
      gatt,
      addEventListener(name, handler) {
        if (name === 'gattserverdisconnected') disconnectHandlers.add(handler);
      },
      removeEventListener(name, handler) {
        if (name === 'gattserverdisconnected') disconnectHandlers.delete(handler);
      },
    };
    return device;
  }

  // Web Bluetooth's navigator.bluetooth.requestDevice takes { filters, ... }.
  // The plugin's requestDevice takes { services, name, namePrefix, ... }.
  // Flatten filter services into the plugin's services list.
  async function requestDevice(options) {
    await ensureBleReady();
    const services = [];
    if (options && Array.isArray(options.filters)) {
      for (const f of options.filters) {
        if (f.services) for (const s of f.services) services.push(toUuid(s));
      }
    }
    const req = {};
    if (services.length) req.services = services;
    // Plugin picker UI; resolves with { deviceId, name } when the user picks.
    const result = await BleClient.requestDevice(req);
    return makeDevice(result);
  }

  const fakeBluetooth = {
    async requestDevice(options) { return requestDevice(options); },
    getAvailability: async () => true,
  };
    try {
      Object.defineProperty(navigator, 'bluetooth', {
        value: fakeBluetooth,
        writable: false,
        configurable: true,
      });
      console.info('[ble-adapter] navigator.bluetooth patched for Capacitor (raw plugin).');
    } catch (e) {
      navigator.bluetooth = fakeBluetooth;
      console.info('[ble-adapter] navigator.bluetooth assigned for Capacitor (raw plugin).');
    }
    try { navigator.bluetooth.__capacitorPatched = true; } catch (e) {}
    setMark('__hrMonitorBleAdapterPatched', true);
  } catch (err) {
    setMark('__hrMonitorBleAdapterLastError', 'outer: ' + (err && err.message ? err.message : String(err)));
    console.error('[ble-adapter] unhandled error in init:', err);
  }
});
