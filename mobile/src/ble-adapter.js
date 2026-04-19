// ble-adapter.js — monkey-patches `navigator.bluetooth` to point at the
// Capacitor @capacitor-community/bluetooth-le plugin, so hr_monitor.html's
// existing Web Bluetooth code (requestDevice → gatt.connect → service →
// characteristic → startNotifications) runs unchanged on Android native.
//
// This file is ONLY loaded in the Capacitor build's www/. When the WebView
// is really a vanilla browser (desktop / Chrome Android as a web page), it
// detects the absence of Capacitor and leaves `navigator.bluetooth` alone.

(function() {
  'use strict';

  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  if (!isNative) return;

  // Capacitor 6 hands out plugin handles via registerPlugin(name). The
  // "@capacitor-community/bluetooth-le" plugin registers under the name
  // "BluetoothLe". Capacitor.Plugins.BluetoothLe is only populated AFTER
  // something calls registerPlugin, so we do that here ourselves — reading
  // it straight off window.Capacitor.Plugins returns undefined.
  let BleClient = null;
  try {
    if (window.Capacitor && typeof window.Capacitor.registerPlugin === 'function') {
      BleClient = window.Capacitor.registerPlugin('BluetoothLe');
    } else {
      BleClient = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BluetoothLe;
    }
  } catch (e) {
    console.error('[ble-adapter] registerPlugin failed:', e);
  }
  if (!BleClient) {
    console.error('[ble-adapter] Capacitor BluetoothLe plugin missing — bail.');
    return;
  }

  // Heart-rate service + characteristic and battery — these are standard
  // UUIDs. hr_monitor.html uses numeric shortcodes (0x180D, 0x2A37). The
  // Capacitor plugin wants full 128-bit UUIDs, so we convert.
  const toUuid = (shortcode) => {
    if (typeof shortcode === 'string') return shortcode;
    const hex = shortcode.toString(16).padStart(4, '0');
    return `0000${hex}-0000-1000-8000-00805f9b34fb`;
  };

  // Shared initialize + enable flag. Done lazily on first requestDevice so
  // we don't pop permission dialogs before the user even clicks Connect.
  let bleInitialized = false;
  async function ensureBleReady() {
    if (bleInitialized) return;
    await BleClient.initialize({ androidNeverForLocation: true });
    try { await BleClient.requestEnable(); } catch (e) { /* already enabled */ }
    bleInitialized = true;
  }

  // Web Bluetooth GATTCharacteristic.addEventListener / removeEventListener
  // for the 'characteristicvaluechanged' event. Capacitor uses
  // BleClient.startNotifications(deviceId, service, char, callback) instead.
  function makeCharacteristic(deviceId, serviceUuid, charUuid) {
    const handlers = new Set();
    let subscribed = false;
    return {
      uuid: charUuid,
      async startNotifications() {
        if (subscribed) return this;
        await BleClient.startNotifications(deviceId, serviceUuid, charUuid, (dataView) => {
          const ev = { target: { value: dataView } };
          for (const h of handlers) { try { h(ev); } catch (e) { console.warn(e); } }
        });
        subscribed = true;
        return this;
      },
      async stopNotifications() {
        if (!subscribed) return this;
        try { await BleClient.stopNotifications(deviceId, serviceUuid, charUuid); } catch (e) {}
        subscribed = false;
        return this;
      },
      async readValue() {
        const dv = await BleClient.read(deviceId, serviceUuid, charUuid);
        return dv;
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
        const charUuid = toUuid(charShortOrUuid);
        return makeCharacteristic(deviceId, serviceUuid, charUuid);
      },
    };
  }

  function makeDevice(info) {
    const disconnectHandlers = new Set();
    const deviceId = info.deviceId;
    let connected = false;

    const gatt = {
      get connected() { return connected; },
      async connect() {
        if (connected) return gatt;
        await BleClient.connect(deviceId, () => {
          connected = false;
          for (const h of disconnectHandlers) { try { h({ target: device }); } catch (e) {} }
        });
        connected = true;
        return gatt;
      },
      disconnect() {
        if (!connected) return;
        connected = false;
        BleClient.disconnect(deviceId).catch(() => {});
      },
      async getPrimaryService(serviceShortOrUuid) {
        const serviceUuid = toUuid(serviceShortOrUuid);
        return makeService(deviceId, serviceUuid);
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

  // Web Bluetooth shape: navigator.bluetooth.requestDevice(options) →
  // BluetoothDevice. Capacitor's equivalent is BleClient.requestDevice.
  async function requestDevice(options) {
    await ensureBleReady();
    const services = [];
    if (options && Array.isArray(options.filters)) {
      for (const f of options.filters) {
        if (f.services) for (const s of f.services) services.push(toUuid(s));
      }
    }
    const req = { services };
    const result = await BleClient.requestDevice(req);
    return makeDevice(result);
  }

  // Expose only if not already defined (desktop WebView could be Chrome WebView
  // with native Web Bluetooth — unlikely, but don't trample it).
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
    console.info('[ble-adapter] navigator.bluetooth patched for Capacitor.');
  } catch (e) {
    // Read-only on this platform; fallback to assignment where possible.
    navigator.bluetooth = fakeBluetooth;
    console.info('[ble-adapter] navigator.bluetooth assigned for Capacitor.');
  }
})();
