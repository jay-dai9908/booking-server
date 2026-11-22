// In-memory event bus for Store Display SSE push updates.
// NOTE: This runs in-memory assuming a single PM2 backend process.
// If scaling to PM2 cluster mode or multiple backend instances, replace this
// with Redis Pub/Sub or PostgreSQL LISTEN/NOTIFY so all workers broadcast events.

const subscribers = new Set();
let stateProvider = null;
let debounceTimer = null;
let flushInFlight = false;
let pendingReflush = false;

// Single active checkout sync state (in-memory; booking_ref kept server-side only)
let activeCheckoutRef = null;
let activeCheckoutPayload = null;
let checkoutClearTimer = null;

// Single active staff push message state (in-memory)
let activeMessagePayload = null;
let messageExpiresAtMs = 0;
let messageClearTimer = null;

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

function broadcastEvent(eventName, payload) {
  for (const client of Array.from(subscribers)) {
    try {
      client.sendEvent(eventName, payload);
    } catch {
      subscribers.delete(client);
    }
  }
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
    broadcastEvent('state', state);
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

export function setCheckoutSync({ booking_ref, payload, autoClearMs }) {
  if (checkoutClearTimer) {
    clearTimeout(checkoutClearTimer);
    checkoutClearTimer = null;
  }
  activeCheckoutRef = booking_ref;
  activeCheckoutPayload = payload;
  broadcastEvent('checkout', payload);

  if (autoClearMs && autoClearMs > 0) {
    checkoutClearTimer = setTimeout(() => {
      checkoutClearTimer = null;
      activeCheckoutRef = null;
      activeCheckoutPayload = null;
      broadcastEvent('checkout', { active: false, phase: 'close' });
    }, autoClearMs);
    if (checkoutClearTimer.unref) checkoutClearTimer.unref();
  }
}

export function clearCheckoutSync(booking_ref) {
  if (!activeCheckoutRef || activeCheckoutRef !== booking_ref) {
    return false;
  }
  if (checkoutClearTimer) {
    clearTimeout(checkoutClearTimer);
    checkoutClearTimer = null;
  }
  activeCheckoutRef = null;
  activeCheckoutPayload = null;
  broadcastEvent('checkout', { active: false, phase: 'close' });
  return true;
}

export function forceClearCheckoutSync() {
  if (checkoutClearTimer) {
    clearTimeout(checkoutClearTimer);
    checkoutClearTimer = null;
  }
  if (activeCheckoutRef || activeCheckoutPayload) {
    activeCheckoutRef = null;
    activeCheckoutPayload = null;
    broadcastEvent('checkout', { active: false, phase: 'close' });
  }
}

export function getActiveCheckout() {
  return activeCheckoutPayload;
}

export function setStaffMessage({ payload, ttlMs }) {
  if (messageClearTimer) {
    clearTimeout(messageClearTimer);
    messageClearTimer = null;
  }
  activeMessagePayload = payload;
  messageExpiresAtMs = Date.now() + Math.max(1000, Number(ttlMs) || 180000);
  broadcastEvent('message', payload);

  if (ttlMs && ttlMs > 0) {
    messageClearTimer = setTimeout(() => {
      messageClearTimer = null;
      activeMessagePayload = null;
      messageExpiresAtMs = 0;
      broadcastEvent('message', { active: false });
    }, ttlMs);
    if (messageClearTimer.unref) messageClearTimer.unref();
  }
}

export function clearStaffMessage() {
  if (messageClearTimer) {
    clearTimeout(messageClearTimer);
    messageClearTimer = null;
  }
  activeMessagePayload = null;
  messageExpiresAtMs = 0;
  broadcastEvent('message', { active: false });
}

export function getActiveMessage() {
  if (!activeMessagePayload) return null;
  if (messageExpiresAtMs > 0 && Date.now() >= messageExpiresAtMs) {
    activeMessagePayload = null;
    messageExpiresAtMs = 0;
    return null;
  }
  return activeMessagePayload;
}

export function resetDisplayBusForTests() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (checkoutClearTimer) {
    clearTimeout(checkoutClearTimer);
    checkoutClearTimer = null;
  }
  if (messageClearTimer) {
    clearTimeout(messageClearTimer);
    messageClearTimer = null;
  }
  activeCheckoutRef = null;
  activeCheckoutPayload = null;
  activeMessagePayload = null;
  messageExpiresAtMs = 0;
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
  setCheckoutSync,
  clearCheckoutSync,
  forceClearCheckoutSync,
  getActiveCheckout,
  setStaffMessage,
  clearStaffMessage,
  getActiveMessage,
  resetDisplayBusForTests
};
