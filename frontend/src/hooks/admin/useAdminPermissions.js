import { useState, useEffect, useCallback } from 'react';
import api from '../../api/axios';
import {
  MONEY_WRITE,
  COUPON_WRITE,
  PASS_GRANT,
  KIOSK_SETTINGS_WRITE,
  GLOBAL_SETTING_FIELD_GROUPS,
  PERMISSION_LABELS,
  canAdminPermission
} from '@shared/permissionGroups.js';

export {
  MONEY_WRITE,
  COUPON_WRITE,
  PASS_GRANT,
  KIOSK_SETTINGS_WRITE,
  GLOBAL_SETTING_FIELD_GROUPS,
  PERMISSION_LABELS,
  canAdminPermission
};

let cachedToken = null;
let cachedProfile = null;
let inflightPromise = null;

function readCurrentSessionToken() {
  try {
    return typeof sessionStorage !== 'undefined'
      ? (sessionStorage.getItem('shiguang_auth_token') || '')
      : '';
  } catch {
    return '';
  }
}

export function clearAdminPermissionsCache() {
  cachedToken = null;
  cachedProfile = null;
  inflightPromise = null;
}

async function loadAdminProfile(force = false) {
  const curToken = readCurrentSessionToken();
  if (!force && cachedProfile && cachedToken === curToken) {
    return cachedProfile;
  }
  if (!force && inflightPromise && cachedToken === curToken) {
    return inflightPromise;
  }

  cachedToken = curToken;
  inflightPromise = api
    .get('/auth/me')
    .then((res) => {
      const data = res.data || {};
      const profile = {
        role: data.role || null,
        isSuperAdmin: Boolean(data.isSuperAdmin || data.is_super_admin),
        permissions: Array.isArray(data.permissions) ? data.permissions : []
      };
      cachedProfile = profile;
      inflightPromise = null;
      return profile;
    })
    .catch((err) => {
      inflightPromise = null;
      throw err;
    });

  return inflightPromise;
}

export function useAdminPermissions() {
  const curToken = readCurrentSessionToken();
  const hasValidCache = Boolean(cachedProfile && cachedToken === curToken);

  const [profile, setProfile] = useState(() =>
    hasValidCache
      ? cachedProfile
      : { role: 'admin', isSuperAdmin: false, permissions: [] }
  );
  const [loading, setLoading] = useState(!hasValidCache);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await loadAdminProfile(true);
      setProfile(next);
      return next;
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const tokenNow = readCurrentSessionToken();
    if (cachedProfile && cachedToken === tokenNow) {
      setProfile(cachedProfile);
      setLoading(false);
      return;
    }
    setLoading(true);
    loadAdminProfile(false)
      .then((next) => {
        if (active && next) {
          setProfile(next);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const can = useCallback(
    (permOrList) =>
      canAdminPermission(
        {
          role: profile.role || 'admin',
          isSuperAdmin: profile.isSuperAdmin,
          permissions: profile.permissions
        },
        permOrList
      ),
    [profile.role, profile.isSuperAdmin, profile.permissions]
  );

  return {
    permissions: profile.permissions,
    isSuperAdmin: profile.isSuperAdmin,
    loading,
    can,
    refresh
  };
}

export default useAdminPermissions;
