import { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../../api/axios';
import { getDayPricing } from '../../utils/customer/pricing';

const memoryCache = {};

export function useDayPricing(dateStr, globalSettings) {
  const [daily, setDaily] = useState(() => (dateStr ? memoryCache[dateStr] || null : null));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!dateStr) return;

    if (memoryCache[dateStr] !== undefined) {
      setDaily(memoryCache[dateStr]);
      return;
    }

    let isMounted = true;
    setLoading(true);

    api.get(`/daily-settings?date=${dateStr}`)
      .then((res) => {
        const data = res.data || null;
        memoryCache[dateStr] = data;
        if (isMounted) {
          setDaily(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        console.error('Failed to fetch daily settings for date:', dateStr, err);
        memoryCache[dateStr] = null;
        if (isMounted) {
          setDaily(null);
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [dateStr]);

  const dayPricing = useMemo(() => {
    if (!dateStr || !globalSettings) return null;
    return getDayPricing(dateStr, globalSettings, daily);
  }, [dateStr, globalSettings, daily]);

  const reload = useCallback(async () => {
    if (!dateStr) return;
    try {
      setLoading(true);
      const res = await api.get(`/daily-settings?date=${dateStr}`);
      const data = res.data || null;
      memoryCache[dateStr] = data;
      setDaily(data);
    } catch (err) {
      console.error('Failed to reload daily settings', err);
    } finally {
      setLoading(false);
    }
  }, [dateStr]);

  return { daily, dayPricing, loading, reload };
}
