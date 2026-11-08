import { useState, useEffect, useRef, useCallback } from 'react';
import api from '../../api/axios';

export function useLiveFloor(date = null, pollInterval = 10000) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const etagRef = useRef(null);

  const fetchLive = useCallback(async (isManual = false) => {
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

      if (res.status === 304) {
        // Data unchanged
        setLoading(false);
        return;
      }

      if (res.headers?.etag) {
        etagRef.current = res.headers.etag;
      }

      setData(res.data);
      setError(null);
    } catch (err) {
      console.error('[useLiveFloor] Error fetching live floor:', err);
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
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
    refresh,
    setData
  };
}

export default useLiveFloor;
