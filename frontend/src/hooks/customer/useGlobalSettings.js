import { useState, useEffect, useCallback } from 'react';
import api from '../../api/axios';

const CACHE_KEY = 'shiguang_customer_settings_v2';

export const DEFAULT_GLOBAL_SETTINGS = {
  weekday_hourly_price: 100,
  weekday_unlimited_price: 550,
  weekend_hourly_price: 150,
  weekend_unlimited_price: 800,
  equipment_discount_enabled: true,
  equipment_discount_buy_hours: 3,
  equipment_discount_free_hours: 1,
  equipment_discount_stackable: true,
  equipment_discount2_enabled: false,
  equipment_discount2_buy_hours: 8,
  equipment_discount2_free_hours: 4,
  show_announcement: false,
  announcement_text: '',
  show_line_button: true,
  line_button_url: '',
  official_line_url: '',
  enable_preview_page: true,
  preview_disabled_text: '時段預覽暫停開放',
  shop_enabled: true,
  show_shop_button: true,
  allow_exceed_pax: false,
  show_equipment_live_stock: true,
};

function readCachedSettings() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_GLOBAL_SETTINGS, ...parsed };
    }
  } catch (e) {
    console.error('Failed to read settings cache', e);
  }
  return DEFAULT_GLOBAL_SETTINGS;
}

export function useGlobalSettings() {
  const [settings, setSettings] = useState(readCachedSettings);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await api.get('/daily-settings/global');
      if (res.data) {
        const merged = { ...DEFAULT_GLOBAL_SETTINGS, ...res.data };
        setSettings(merged);
        setError(null);
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(res.data));
        } catch (e) {}
      }
    } catch (err) {
      console.error('Failed to fetch global settings', err);
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  return { settings, loading, error, reload: fetchSettings };
}
