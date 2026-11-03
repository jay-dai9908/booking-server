import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../api/axios';

export const BOOKING_LOOKAHEAD_DAYS = 90;

export function useSessions(dateStr, options = {}) {
  const { onUpdated, autoRefresh = true } = options;
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [updateText, setUpdateText] = useState('剛剛更新');
  const onUpdatedRef = useRef(onUpdated);
  onUpdatedRef.current = onUpdated;

  const fetchSessions = useCallback(async (isBackground = false) => {
    if (!dateStr) return;
    if (!isBackground) setLoading(true);

    try {
      const res = await api.get(`/sessions?date=${dateStr}`);
      const data = Array.isArray(res.data) ? res.data : [];
      setSessions(data);
      const now = new Date();
      setLastUpdated(now);
      setError(null);
      if (onUpdatedRef.current) {
        onUpdatedRef.current(data);
      }
    } catch (err) {
      console.error('Failed to fetch sessions for date:', dateStr, err);
      setError(err);
    } finally {
      if (!isBackground) setLoading(false);
    }
  }, [dateStr]);

  // Recalculate updateText every 30 seconds
  useEffect(() => {
    const calcText = () => {
      if (!lastUpdated) {
        setUpdateText('剛剛更新');
        return;
      }
      const diffSec = Math.floor((Date.now() - lastUpdated.getTime()) / 1000);
      if (diffSec < 60) {
        setUpdateText('剛剛更新');
      } else {
        const mins = Math.floor(diffSec / 60);
        setUpdateText(`${mins} 分鐘前更新`);
      }
    };

    calcText();
    const interval = setInterval(calcText, 30000);
    return () => clearInterval(interval);
  }, [lastUpdated]);

  // Initial fetch and dependency on dateStr
  useEffect(() => {
    fetchSessions(false);
  }, [fetchSessions]);

  // Auto-refresh every 60s when visible + on focus/visibility change
  useEffect(() => {
    if (!autoRefresh || !dateStr) return;

    const handleRefresh = () => {
      if (document.visibilityState === 'visible') {
        fetchSessions(true);
      }
    };

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchSessions(true);
      }
    }, 60000);

    window.addEventListener('focus', handleRefresh);
    document.addEventListener('visibilitychange', handleRefresh);

    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', handleRefresh);
      document.removeEventListener('visibilitychange', handleRefresh);
    };
  }, [autoRefresh, dateStr, fetchSessions]);

  return {
    sessions,
    loading,
    error,
    lastUpdated,
    updateText,
    reload: () => fetchSessions(false),
  };
}

export function useSessionRange(startDate, endDate) {
  const [sessionsByDate, setSessionsByDate] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchRange = useCallback(async () => {
    if (!startDate || !endDate) return;
    try {
      setLoading(true);
      const res = await api.get(`/sessions?start_date=${startDate}&end_date=${endDate}`);
      const raw = Array.isArray(res.data) ? res.data : [];
      const grouped = {};
      for (const s of raw) {
        const k = String(s.session_date).slice(0, 10);
        (grouped[k] ||= []).push(s);
      }
      setSessionsByDate(grouped);
      setError(null);
    } catch (err) {
      console.error('Failed to fetch session range', err);
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  useEffect(() => {
    fetchRange();

    const handleFocus = () => {
      if (document.visibilityState === 'visible') {
        fetchRange();
      }
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleFocus);
    };
  }, [fetchRange]);

  return { sessionsByDate, loading, error, reload: fetchRange };
}
