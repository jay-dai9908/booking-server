import { useState, useEffect, useRef, useCallback } from 'react';
import api from '../../api/axios';

export function useLiveFloor(date = null, pollInterval = 10000, options = {}) {
  const { syncWithServerNow, getServerNow } = options || {};
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastOkAt, setLastOkAt] = useState(null);
  const [offline, setOffline] = useState(false);
  const etagRef = useRef(null);
  const requestSeqRef = useRef(0);
  const failCountRef = useRef(0);
  const syncClockRef = useRef(syncWithServerNow);
  const getClockRef = useRef(getServerNow);
  syncClockRef.current = syncWithServerNow;
  getClockRef.current = getServerNow;

  const fetchLive = useCallback(async (isManual = false) => {
    const seq = ++requestSeqRef.current;
    try {
      const headers = {};
      if (etagRef.current && !isManual) {
        headers['If-None-Match'] = etagRef.current;
      }

      const res = await api.get('/floor/live', {
        params: date ? { date } : {},
        headers,
        validateStatus: (status) => (status >= 200 && status < 300) || status === 304
      });

      if (seq !== requestSeqRef.current) return;

      const headerNow = res.headers?.['x-server-now'] || res.headers?.get?.('x-server-now');
      failCountRef.current = 0;
      setOffline(false);
      setError(null);

      if (res.status === 304) {
        if (headerNow) {
          syncClockRef.current?.(headerNow);
          setLastOkAt(headerNow);
        } else {
          const fallbackNow = getClockRef.current?.();
          setLastOkAt(
            fallbackNow instanceof Date && !Number.isNaN(fallbackNow.getTime())
              ? fallbackNow.toISOString()
              : new Date().toISOString()
          );
        }
        setLoading(false);
        return;
      }

      if (res.headers?.etag) {
        etagRef.current = res.headers.etag;
      }

      const okNow = res.data?.server_now || headerNow || new Date().toISOString();
      syncClockRef.current?.(okNow);
      setLastOkAt(okNow);
      setData(res.data);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      console.error('[useLiveFloor] Error fetching live floor:', err);
      const status = err?.response?.status;
      if (status !== 401 && status !== 403) {
        failCountRef.current += 1;
        if (failCountRef.current >= 2) {
          setOffline(true);
        }
      }
      setError(err.response?.data?.error || err.message);
    } finally {
      if (seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [date]);

  useEffect(() => {
    setLoading(true);
    etagRef.current = null;
    fetchLive(true);

    if (pollInterval > 0) {
      const timer = setInterval(() => {
        fetchLive(false);
      }, pollInterval);
      return () => clearInterval(timer);
    }
  }, [fetchLive, pollInterval]);

  const refresh = useCallback(() => {
    return fetchLive(true);
  }, [fetchLive]);

  return {
    data,
    loading,
    error,
    lastOkAt,
    offline,
    refresh,
    setData
  };
}

export default useLiveFloor;
