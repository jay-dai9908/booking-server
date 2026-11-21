// frontend/src/pages/Display/DisplayPage.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api/axios';
import { decide } from '@shared/displaySchedule.js';
import DisplayLoginScreen from '../../components/display/DisplayLoginScreen';
import DisplayTopBar from '../../components/display/DisplayTopBar';
import DisplayTimersLayout from '../../components/display/DisplayTimersLayout';
import DisplaySlideCard from '../../components/display/DisplaySlideCard';
import DisplaySelfSide from '../../components/display/DisplaySelfSide';
import DisplayTicker from '../../components/display/DisplayTicker';
import {
  computeBurnInShift,
  formatTaipeiDateShort,
  formatTaipeiHHmm,
  getClosingWarning,
  getTaipeiDateStr
} from '../../utils/display/seatStatus';
import { msUntilNextTaipei0400 } from '../../utils/display/taipeiReload';

export const DISPLAY_TOKEN_STORAGE_KEY = 'sg_display_token';

function getApiBaseUrl() {
  return api.defaults.baseURL || (import.meta.env.PROD ? '/api' : 'http://localhost:3001/api');
}

function BrandBlobs() {
  return (
    <>
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
    </>
  );
}

export default function DisplayPage() {
  const [token, setToken] = useState(() => {
    try {
      return localStorage.getItem(DISPLAY_TOKEN_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });
  const [loginError, setLoginError] = useState('');
  const [stateData, setStateData] = useState(null);
  const [offline, setOffline] = useState(false);

  // Server time synchronization
  const serverOffsetRef = useRef(0);
  const [clockNowMs, setClockNowMs] = useState(() => Date.now());
  const [seatNowMs, setSeatNowMs] = useState(() => Date.now());
  const lastSeatMinuteRef = useRef(-1);

  // Rotation indices
  const [cardIdx, setCardIdx] = useState(0);
  const [annIdx, setAnnIdx] = useState(0);
  const [slideIdx, setSlideIdx] = useState(0);

  // Viewport scaling (1920x1080 proportional fit)
  const [scale, setScale] = useState(() => {
    if (typeof window === 'undefined') return 1;
    return Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  });

  useEffect(() => {
    const updateScale = () => {
      setScale(Math.min(window.innerWidth / 1920, window.innerHeight / 1080));
    };
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, []);

  const handleForcedLogout = useCallback((message = '此顯示屏已被登出，請重新登入') => {
    try {
      localStorage.removeItem(DISPLAY_TOKEN_STORAGE_KEY);
    } catch {}
    setToken('');
    setStateData(null);
    setOffline(false);
    setLoginError(message);
  }, []);

  const applyServerState = useCallback((payload) => {
    if (!payload || typeof payload !== 'object') return;
    if (payload.server_now) {
      const serverMs = new Date(payload.server_now).getTime();
      if (Number.isFinite(serverMs)) {
        const offset = serverMs - Date.now();
        serverOffsetRef.current = offset;
        setClockNowMs(serverMs);
        setSeatNowMs(serverMs);
        lastSeatMinuteRef.current = Math.floor(serverMs / 60000);
      }
    }
    setStateData(payload);
    setOffline(false);
  }, []);

  const fetchDisplayState = useCallback(async (activeToken) => {
    if (!activeToken) return;
    try {
      const res = await api.get('/display/state', {
        headers: { Authorization: `Bearer ${activeToken}` }
      });
      applyServerState(res.data);
    } catch (err) {
      const status = err.response?.status;
      const errCode = err.response?.data?.error;
      if (status === 401 || errCode === 'DISPLAY_LOGGED_OUT') {
        handleForcedLogout('此顯示屏已被登出，請重新登入');
      } else {
        setOffline(true);
      }
    }
  }, [applyServerState, handleForcedLogout]);

  // Initial fetch + SSE subscription when token is present
  useEffect(() => {
    if (!token) return undefined;
    let active = true;
    let es = null;
    let offlineProbeTimer = null;

    fetchDisplayState(token);

    const streamUrl = `${getApiBaseUrl()}/display/stream?token=${encodeURIComponent(token)}`;
    es = new EventSource(streamUrl);

    es.addEventListener('state', (ev) => {
      if (!active) return;
      try {
        const parsed = JSON.parse(ev.data);
        applyServerState(parsed);
      } catch {}
    });

    es.addEventListener('reload', () => {
      if (!active) return;
      window.location.reload();
    });

    es.addEventListener('logout', () => {
      if (!active) return;
      es?.close();
      handleForcedLogout('此顯示屏已被登出，請重新登入');
    });

    es.onerror = () => {
      if (!active) return;
      setOffline(true);
      // Probe auth status once if EventSource failed (to catch 401 DISPLAY_LOGGED_OUT quickly)
      if (!offlineProbeTimer) {
        offlineProbeTimer = setTimeout(() => {
          offlineProbeTimer = null;
          if (active) fetchDisplayState(token);
        }, 3000);
      }
    };

    return () => {
      active = false;
      if (offlineProbeTimer) clearTimeout(offlineProbeTimer);
      es?.close();
    };
  }, [token, applyServerState, fetchDisplayState, handleForcedLogout]);

  // 1-second synced clock + 1-minute seat timer update
  useEffect(() => {
    const id = setInterval(() => {
      const syncedNow = Date.now() + serverOffsetRef.current;
      setClockNowMs(syncedNow);
      const minBucket = Math.floor(syncedNow / 60000);
      if (minBucket !== lastSeatMinuteRef.current) {
        lastSeatMinuteRef.current = minBucket;
        setSeatNowMs(syncedNow);
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // WakeLock (safe try/catch + re-request on visibilitychange)
  useEffect(() => {
    if (!token) return undefined;
    let sentinel = null;
    let active = true;

    const requestWakeLock = async () => {
      try {
        if (navigator?.wakeLock && typeof navigator.wakeLock.request === 'function') {
          sentinel = await navigator.wakeLock.request('screen');
        }
      } catch {
        // Ignore browser permission/visibility denial
      }
    };

    const handleVisibility = () => {
      if (active && document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };

    requestWakeLock();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', handleVisibility);
      try {
        sentinel?.release?.();
      } catch {}
    };
  }, [token]);

  // Daily 04:00 Asia/Taipei auto-reload
  useEffect(() => {
    if (!token) return undefined;
    const delay = msUntilNextTaipei0400(Date.now() + serverOffsetRef.current);
    const id = setTimeout(() => {
      window.location.reload();
    }, delay);
    return () => clearTimeout(id);
  }, [token]);

  // Determine current view & settings
  const settings = stateData?.settings || {};
  const dayType = stateData?.day_type || 'weekday';
  const seats = useMemo(() => (Array.isArray(stateData?.seats) ? stateData.seats : []), [stateData]);

  const decision = useMemo(() => {
    if (!stateData) return { on: false, content: 'off', window: null };
    if (settings?.schedule) {
      return decide({
        dayType,
        schedule: settings.schedule,
        specialDates: settings.special_dates || [],
        date: getTaipeiDateStr(clockNowMs),
        now: clockNowMs,
        openTime: stateData.open || null,
        closeTime: stateData.close || null
      });
    }
    return stateData.decision || { on: true, content: 'timers', window: null };
  }, [stateData, settings.schedule, settings.special_dates, dayType, clockNowMs]);

  const effectiveContent = useMemo(() => {
    if (!stateData) return 'loading';
    if (!decision?.on || decision?.content === 'off') return 'off';
    let c = decision.content || 'timers';
    const fallbackEnabled = settings.fallback_to_slides !== false;
    if ((c === 'timers' || c === 'timers_self') && fallbackEnabled) {
      const hasSeated = seats.some(s => {
        if (s.state === 'running' || s.state === 'unlimited' || s.state === 'paused') return true;
        if (s.state === 'booked') return false;
        const org = s.origin_at ? new Date(s.origin_at).getTime() : NaN;
        return Number.isFinite(org) && seatNowMs >= org;
      });
      if (!hasSeated) {
        c = c === 'timers' ? 'slides_gen' : 'slides_self';
      }
    }
    return c;
  }, [stateData, decision, settings.fallback_to_slides, seats, seatNowMs]);

  // Rotation intervals
  const cardSec = Math.max(5, Math.min(60, Number(settings.card_seconds) || 12));
  const annSec = Math.max(5, Math.min(60, Number(settings.announcement_seconds) || 10));
  const defaultSlideSec = Math.max(4, Math.min(60, Number(settings.slide_seconds) || 8));

  useEffect(() => {
    if (!token) return undefined;
    const id = setInterval(() => setCardIdx(c => c + 1), cardSec * 1000);
    return () => clearInterval(id);
  }, [token, cardSec]);

  useEffect(() => {
    if (!token) return undefined;
    const id = setInterval(() => setAnnIdx(a => a + 1), annSec * 1000);
    return () => clearInterval(id);
  }, [token, annSec]);

  const activeSlideSet = effectiveContent === 'slides_self' ? 'self' : 'general';
  const allSlidesForSet = useMemo(() => {
    const raw = stateData?.slides;
    if (!raw) return [];
    if (Array.isArray(raw)) {
      return raw.filter(s => s && s.enabled !== false && (!s.set || s.set === activeSlideSet));
    }
    if (typeof raw === 'object') {
      const list = raw[activeSlideSet];
      return Array.isArray(list) ? list.filter(s => s && s.enabled !== false) : [];
    }
    return [];
  }, [stateData, activeSlideSet]);
  const activeSlides = allSlidesForSet;

  const currentSlideDurationSec = useMemo(() => {
    if (activeSlides.length > 0) {
      const cur = activeSlides[slideIdx % activeSlides.length];
      const sec = Number(cur?.seconds);
      if (Number.isFinite(sec) && sec >= 4) return sec;
    }
    return defaultSlideSec;
  }, [activeSlides, slideIdx, defaultSlideSec]);

  useEffect(() => {
    if (!token) return undefined;
    const id = setTimeout(() => setSlideIdx(s => s + 1), currentSlideDurationSec * 1000);
    return () => clearTimeout(id);
  }, [token, slideIdx, currentSlideDurationSec]);

  // Heartbeat every 60s
  useEffect(() => {
    if (!token || !stateData) return undefined;
    const sendHeartbeat = () => {
      api.post(
        '/display/heartbeat',
        { current_view: effectiveContent },
        { headers: { Authorization: `Bearer ${token}` } }
      ).catch((err) => {
        if (err.response?.status === 401 || err.response?.data?.error === 'DISPLAY_LOGGED_OUT') {
          handleForcedLogout('此顯示屏已被登出，請重新登入');
        }
      });
    };
    sendHeartbeat();
    const id = setInterval(sendHeartbeat, 60000);
    return () => clearInterval(id);
  }, [token, stateData, effectiveContent, handleForcedLogout]);

  const handleLoginSuccess = (newToken) => {
    try {
      localStorage.setItem(DISPLAY_TOKEN_STORAGE_KEY, newToken);
    } catch {}
    setLoginError('');
    setToken(newToken);
  };

  // Burn-in shift (0 when off or not logged in)
  const isOff = Boolean(token && stateData && effectiveContent === 'off');
  const shift = computeBurnInShift(
    clockNowMs,
    Number(settings.shift_minutes) || 3,
    !token || !stateData || isOff
  );

  const dateText = formatTaipeiDateShort(clockNowMs);
  const clockText = formatTaipeiHHmm(clockNowMs);
  const dateStr = stateData?.date || getTaipeiDateStr(clockNowMs);

  const closingWarning = useMemo(() => {
    if (!stateData) return '';
    return getClosingWarning({
      closingWarn: settings.closing_warn !== false,
      closingMinutes: Number(settings.closing_minutes) || 30,
      openTime: stateData.open || null,
      closeTime: stateData.close || null,
      nowMs: clockNowMs,
      dateStr
    });
  }, [stateData, settings.closing_warn, settings.closing_minutes, clockNowMs, dateStr]);

  const renderDisplayBody = () => {
    if (!token) {
      return <DisplayLoginScreen onLoginSuccess={handleLoginSuccess} initialError={loginError} />;
    }

    if (!stateData) {
      return (
        <div
          data-testid="display-loading"
          className="w-full h-full bg-sg-bg text-sg-ink flex flex-col items-center justify-center font-display"
          style={{ fontSize: 36 }}
        >
          <BrandBlobs />
          <div className="relative z-10">載入顯示內容中...</div>
        </div>
      );
    }

    if (effectiveContent === 'off') {
      return <div data-testid="display-off-screen" className="w-full h-full bg-black" />;
    }

    const lineInfo = stateData.line || {};
    const notices = stateData.notices || settings.notices || [];
    const announcements = stateData.announcements || settings.announcements || [];
    const showLineMini = settings.show_line_mini !== false;

    return (
      <div
        data-testid="display-active-screen"
        data-display-content={effectiveContent}
        className="relative w-full h-full bg-sg-bg text-sg-ink font-body overflow-hidden pointer-events-none select-none"
      >
        <BrandBlobs />

        <DisplayTopBar
          dateText={dateText}
          dayType={dayType}
          clockText={clockText}
          offline={offline}
          screenScale={scale}
        />

        {(effectiveContent === 'timers' || effectiveContent === 'timers_self') && (
          <DisplayTimersLayout
            selfMode={effectiveContent === 'timers_self'}
            floorMap={stateData.floor_map}
            rotation={Number(settings.map_rotation ?? 90)}
            hereElement={settings.here_element || ''}
            seats={seats}
            nowMs={seatNowMs}
            soonMinutes={Number(settings.soon_minutes) || 10}
            timeMode={settings.time_mode || 'remain'}
            cardsConfig={settings.cards}
            cardsData={stateData.cards}
            price={stateData.price}
            dayType={dayType}
            cardIdx={cardIdx}
            line={lineInfo}
            notices={notices}
          />
        )}

        {effectiveContent === 'slides_self' && (
          <div
            data-testid="display-layout-slides-self"
            className="absolute grid"
            style={{
              left: 64,
              right: 64,
              top: 150,
              bottom: 108,
              gridTemplateColumns: '1fr 440px',
              gap: 30
            }}
          >
            <DisplaySlideCard setType="self" slides={activeSlides} slideIdx={slideIdx} />
            <div className="flex flex-col min-h-0" style={{ gap: 28 }}>
              <DisplaySelfSide line={lineInfo} notices={notices} compactQr={false} />
            </div>
          </div>
        )}

        {effectiveContent === 'slides_gen' && (
          <div
            data-testid="display-layout-slides-gen"
            className="absolute grid"
            style={{
              left: 64,
              right: 64,
              top: 150,
              bottom: 108,
              gridTemplateColumns: '1fr',
              gap: 30
            }}
          >
            <DisplaySlideCard setType="general" slides={activeSlides} slideIdx={slideIdx} />
          </div>
        )}

        <DisplayTicker
          announcements={announcements}
          annIdx={annIdx}
          closingWarning={closingWarning}
          isSelfMode={effectiveContent === 'timers_self' || effectiveContent === 'slides_self'}
          isSelfSlides={effectiveContent === 'slides_self'}
          showLineMini={showLineMini}
          line={lineInfo}
        />
      </div>
    );
  };

  return (
    <div className="w-screen h-screen bg-black flex items-center justify-center overflow-hidden select-none">
      <div
        data-display-screen
        className="relative bg-black overflow-hidden flex-none"
        style={{
          width: 1920,
          height: 1080,
          transform: `scale(${scale})`,
          transformOrigin: 'center center'
        }}
      >
        <div
          data-testid="display-burnin-shift"
          className="absolute"
          style={{
            inset: -10,
            transition: 'transform 1.2s ease',
            transform: isOff ? 'none' : `translate(${shift.dx}px, ${shift.dy}px)`
          }}
        >
          <div className="absolute" style={{ inset: 10 }}>
            {renderDisplayBody()}
          </div>
        </div>
      </div>
    </div>
  );
}
