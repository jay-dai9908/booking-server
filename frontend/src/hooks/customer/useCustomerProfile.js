import { useState, useEffect, useCallback } from 'react';
import api from '../../api/axios';

export function useCustomerProfile() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchProfile = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get('/auth/me');
      if (res.data?.user) {
        setUser(res.data.user);
      } else if (res.data) {
        setUser(res.data);
      }
      setError(null);
    } catch (err) {
      setUser(null);
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  return { user, loading, error, reload: fetchProfile };
}
