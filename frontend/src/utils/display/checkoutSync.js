// frontend/src/utils/display/checkoutSync.js
import api from '../../api/axios';

export const DISPLAY_CHECKOUT_SYNC_KEY = 'sg_display_checkout_sync';

export function isDisplayCheckoutSyncEnabled() {
  try {
    return localStorage.getItem(DISPLAY_CHECKOUT_SYNC_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setDisplayCheckoutSyncEnabled(enabled) {
  try {
    localStorage.setItem(DISPLAY_CHECKOUT_SYNC_KEY, enabled ? '1' : '0');
  } catch {}
}

export function postDisplayCheckout({
  booking_ref,
  phase,
  person_nos = null,
  method = null,
  cash_received = null
}) {
  if (!booking_ref || !phase) return Promise.resolve();
  return api.post('/display/checkout', {
    booking_ref,
    phase,
    person_nos,
    method,
    cash_received
  }).catch(() => {});
}

export function sendDisplayCheckoutCloseKeepalive(booking_ref) {
  if (!booking_ref) return;
  const base = api.defaults.baseURL || (import.meta.env.PROD ? '/api' : 'http://localhost:3001/api');
  const url = `${base}/display/checkout`;
  const payload = JSON.stringify({ booking_ref, phase: 'close' });

  let token = '';
  let deviceId = '';
  let deviceLabel = '';
  try {
    token = sessionStorage.getItem('shiguang_auth_token') || '';
    deviceId = localStorage.getItem('sg-device-id') || '';
    deviceLabel = localStorage.getItem('sg-device-label') || '';
  } catch {}

  if (!token && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(url, blob);
      return;
    } catch {}
  }

  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (deviceId) headers['X-Device-Id'] = deviceId;
  if (deviceLabel) headers['X-Device-Label'] = encodeURIComponent(deviceLabel);

  try {
    fetch(url, {
      method: 'POST',
      headers,
      body: payload,
      keepalive: true,
      credentials: 'include'
    }).catch(() => {});
  } catch {}
}
