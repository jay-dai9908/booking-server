import { useState, useEffect, useCallback } from 'react';
import api from '../../api/axios';

export function usePrinterStatus(pollInterval = 15000) {
  const [station, setStation] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api.get('/print/status');
      setStation(res.data?.station || null);
    } catch (err) {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    if (pollInterval > 0) {
      const timer = setInterval(fetchStatus, pollInterval);
      return () => clearInterval(timer);
    }
  }, [fetchStatus, pollInterval]);

  return {
    station,
    loading,
    refresh: fetchStatus
  };
}

export default usePrinterStatus;
