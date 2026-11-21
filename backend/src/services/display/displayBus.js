// In-memory event bus for Store Display SSE push updates.
// NOTE: This runs in-memory assuming a single PM2 backend process.
// If scaling to PM2 cluster mode or multiple backend instances, replace this
// with Redis Pub/Sub or PostgreSQL LISTEN/NOTIFY so all workers broadcast events.

const subscribers = new Set();
let stateProvider = null;
let debounceTimer = null;
let flushInFlight = false;
let pendingReflush = false;

const DEBOUNCE_MS = 1000; // Coalesce rapid floor/billing/setting changes within 2s

export function setDisplayStateProvider(fn) {
  stateProvider = fn;
}

export function subscribeDisplayClient(client) {
  subscribers.add(client);
  return () => {
    subscribers.delete(client);
  };
}

export function getDisplaySubscriberCount() {
  return subscribers.size;
}

async function broadcastStateNow() {
  if (subscribers.size === 0 || typeof stateProvider !== 'function') return;
  if (flushInFlight) {
    pendingReflush = true;
    return;
  }
  flushInFlight = true;
  try {
    const state = await stateProvider();
    for (const client of Array.from(subscribers)) {
      try {
        client.sendEvent('state', state);
      } catch {
        subscribers.delete(client);
      }
    }
  } catch (err) {
    console.error('[displayBus] broadcastStateNow error:', err.message);
  } finally {
    flushInFlight = false;
    if (pendingReflush) {
      pendingReflush = false;
      scheduleFloorChanged();
    }
  }
}

function scheduleFloorChanged() {
  if (subscribers.size === 0) return;
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    broadcastStateNow();
  }, DEBOUNCE_MS);
  if (debounceTimer.unref) debounceTimer.unref();
}

export function floorChanged() {
  scheduleFloorChanged();
}

export function settingsChanged() {
  scheduleFloorChanged();
}

export function reloadDevice(deviceId) {
  const id = Number(deviceId);
  for (const client of Array.from(subscribers)) {
    if (client.deviceId === id) {
      try {
        client.sendEvent('reload', { reason: 'admin_reload', at: new Date().toISOString() });
      } catch {
        subscribers.delete(client);
      }
    }
  }
}

export function deviceLoggedOut(deviceId) {
  const id = Number(deviceId);
  for (const client of Array.from(subscribers)) {
    if (client.deviceId === id) {
      try {
        client.sendEvent('logout', { error: 'DISPLAY_LOGGED_OUT' });
        client.close();
      } catch {
        // ignore close errors
      }
      subscribers.delete(client);
    }
  }
}

export function resetDisplayBusForTests() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingReflush = false;
  for (const client of Array.from(subscribers)) {
    try {
      client.close();
    } catch {
      // ignore
    }
  }
  subscribers.clear();
}

export default {
  setDisplayStateProvider,
  subscribeDisplayClient,
  getDisplaySubscriberCount,
  floorChanged,
  settingsChanged,
  reloadDevice,
  deviceLoggedOut,
  resetDisplayBusForTests
};
