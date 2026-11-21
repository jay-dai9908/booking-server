// frontend/src/components/display/DisplayLoginScreen.jsx
import React, { useEffect, useState } from 'react';
import api from '../../api/axios';

/**
 * First-login screen for /display matching store-display-mock.html ("首次登入").
 * Note: This is the ONLY screen on /display that allows interaction (keyboard/pointer for initial setup).
 */
export default function DisplayLoginScreen({ onLoginSuccess, initialError = '' }) {
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState('1');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(initialError);

  useEffect(() => {
    setError(initialError);
  }, [initialError]);

  useEffect(() => {
    let mounted = true;
    api.get('/display/devices')
      .then(res => {
        if (!mounted) return;
        const list = Array.isArray(res.data?.devices)
          ? res.data.devices
          : (Array.isArray(res.data) ? res.data : []);
        if (list.length > 0) {
          setDevices(list);
          setDeviceId(String(list[0].id));
        }
      })
      .catch(() => {
        // Public device list may not be available; manual device_id input still works.
      });
    return () => {
      mounted = false;
    };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setError('');
    if (!password) {
      setError('請輸入顯示屏密碼');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        device_id: /^\d+$/.test(String(deviceId).trim()) ? Number(deviceId) : String(deviceId).trim(),
        password
      };
      const res = await api.post('/display/login', payload);
      const token = res.data?.token;
      if (!token) {
        setError('登入回應缺少權杖');
        return;
      }
      onLoginSuccess(token, res.data?.device || null);
    } catch (err) {
      const msg = err.response?.data?.error || err.response?.data?.message;
      if (err.response?.status === 429) {
        setError('密碼錯誤次數過多，請 10 分鐘後再試');
      } else {
        setError(msg || '帳號或密碼錯誤');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid="display-login-screen"
      className="relative w-full h-full bg-sg-bg text-sg-ink font-body overflow-hidden flex items-center justify-center"
    >
      {/* Decorative brand blobs */}
      <svg
        className="absolute pointer-events-none"
        style={{ left: -120, top: -160 }}
        width="620"
        height="520"
        viewBox="0 0 620 520"
        aria-hidden="true"
      >
        <path
          d="M120 60c110-70 290-40 380 60s70 250-60 320-330 60-410-40S10 130 120 60z"
          fill="#F7E3DA"
        />
      </svg>
      <svg
        className="absolute pointer-events-none"
        style={{ right: -140, bottom: -200 }}
        width="680"
        height="560"
        viewBox="0 0 680 560"
        aria-hidden="true"
      >
        <path
          d="M160 90c130-80 330-50 430 70s60 280-90 340-370 40-450-70S30 170 160 90z"
          fill="#EFC9BC"
          opacity=".55"
        />
      </svg>

      <form
        onSubmit={handleSubmit}
        className="bg-sg-paper relative z-10 flex flex-col items-stretch"
        style={{
          width: 880,
          padding: '66px 80px',
          borderRadius: 40,
          gap: 28,
          boxShadow: '0 10px 30px rgba(139,91,67,0.08)'
        }}
      >
        <img
          src="/logo.png"
          alt="拾光製所"
          className="rounded-full self-center object-cover"
          style={{
            width: 140,
            height: 140,
            boxShadow: '0 0 0 6px #FFFDF9, 0 4px 14px rgba(62,51,43,0.12)'
          }}
        />
        <h2
          className="font-display font-bold text-center text-sg-ink m-0"
          style={{ fontSize: 58, lineHeight: 1.3 }}
        >
          店內顯示屏登入
        </h2>

        <label className="flex flex-col text-sg-muted" style={{ gap: 10, fontSize: 30 }}>
          <span>裝置</span>
          {devices.length > 0 ? (
            <select
              data-testid="display-login-device-select"
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              className="rounded-full bg-sg-bg border-2 border-sg-line text-sg-ink font-body outline-none focus:border-sg-brown"
              style={{ height: 96, fontSize: 36, padding: '0 36px' }}
            >
              {devices.map(d => (
                <option key={d.id} value={String(d.id)}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              data-testid="display-login-device-input"
              type="text"
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              placeholder="裝置編號（預設 1）"
              className="rounded-full bg-sg-bg border-2 border-sg-line text-sg-ink font-body outline-none focus:border-sg-brown"
              style={{ height: 96, fontSize: 36, padding: '0 36px' }}
            />
          )}
        </label>

        <label className="flex flex-col text-sg-muted" style={{ gap: 10, fontSize: 30 }}>
          <span>密碼</span>
          <input
            data-testid="display-login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="請輸入顯示屏密碼"
            autoComplete="current-password"
            className="rounded-full bg-sg-bg border-2 border-sg-line text-sg-ink font-body outline-none focus:border-sg-brown"
            style={{ height: 96, fontSize: 36, padding: '0 36px' }}
          />
        </label>

        {error && (
          <div
            data-testid="display-login-error"
            className="text-sg-danger font-bold text-center"
            style={{ fontSize: 28 }}
          >
            {error}
          </div>
        )}

        <button
          data-testid="display-login-submit"
          type="submit"
          disabled={submitting}
          className="rounded-full bg-sg-brown hover:bg-sg-brown-hover text-sg-paper font-body font-bold flex items-center justify-center cursor-pointer disabled:opacity-60 border-0"
          style={{ height: 104, fontSize: 40 }}
        >
          {submitting ? '登入中...' : '登入並開始顯示'}
        </button>

        <small className="text-sg-muted" style={{ fontSize: 25, lineHeight: 1.6 }}>
          只要第一次登入。之後這台一直保持登入，重開機也不用再登入；只有在後台改了這個帳號的密碼，或按「登出這台」，才需要重新登入。
        </small>
      </form>
    </div>
  );
}
