import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Grid, Sparkles } from 'lucide-react';
import CustomerLayout from '../../components/customer/CustomerLayout';
import BrandLogo from '../../components/customer/BrandLogo';
import PriceCard from '../../components/customer/PriceCard';
import { Card } from '../../components/customer/Card';
import Pill from '../../components/customer/Pill';
import Button from '../../components/customer/Button';
import Skeleton from '../../components/customer/Skeleton';
import EmptyState from '../../components/customer/EmptyState';
import { AnnouncementBar, ErrorBanner } from '../../components/customer/Banners';
import { BeadLoader } from '../../components/customer/Bead';
import GuestLineLoginButton from '../../components/customer/GuestLineLoginButton';
import PriceInfoSheet from '../../components/customer/sheets/PriceInfoSheet';
import api from '../../api/axios';
import { getBrowserClientInfoAsync } from '../../utils/clientInfo';
import { initiateLineOAuth } from '../../utils/lineAuth';
import { useGlobalSettings } from '../../hooks/customer/useGlobalSettings';
import { useDayPricing } from '../../hooks/customer/useDayPricing';
import { useSessions } from '../../hooks/customer/useSessions';
import { buildDiscountConfig } from '../../utils/customer/pricing';
import { boardDiscountTexts } from '../../utils/customer/discountText';
import { dayState } from '../../utils/customer/availability';
import { taipeiToday } from '../../utils/customer/taipeiTime';
import { safeNextPath } from '../../utils/customer/nextPath';
import { formatMoney } from '../../utils/customer/format';

export default function Home({ userRole }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [authErrorMsg, setAuthErrorMsg] = useState('');
  const [lineStateInvalid, setLineStateInvalid] = useState(false);
  const [failedStatePrefix, setFailedStatePrefix] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPriceInfoOpen, setIsPriceInfoOpen] = useState(false);
  const [equipmentConfigs, setEquipmentConfigs] = useState([]);
  const [equipmentsLoaded, setEquipmentsLoaded] = useState(false);
  const hasProcessedRef = useRef(false);

  const todayStr = useMemo(() => taipeiToday(), []);
  const {
    settings: globalSettings,
    loading: globalLoading,
    error: globalError,
    reload: reloadGlobalSettings,
    hasPricing,
  } = useGlobalSettings();
  const { dayPricing } = useDayPricing(todayStr, globalSettings);
  const { sessions } = useSessions(todayStr, { autoRefresh: true });

  // 1. 已登入顧客自動導向目標頁面
  useEffect(() => {
    const queryParams = new URLSearchParams(location.search);
    if (queryParams.has('code')) return;

  const safeNext = useMemo(() => {
    const rawNext = new URLSearchParams(location.search).get('next');
    return safeNextPath(rawNext);
  }, [location.search]);

  useEffect(() => {
    const queryParams = new URLSearchParams(location.search);
    if (queryParams.get('code')) return;

    if (userRole === 'customer') {
      let target = safeNext || '/booking';
      try {
        const savedRedirect =
          sessionStorage.getItem('shiguang_post_login_redirect') ||
          localStorage.getItem('shiguang_post_login_redirect');
        if (savedRedirect) {
          sessionStorage.removeItem('shiguang_post_login_redirect');
          localStorage.removeItem('shiguang_post_login_redirect');
          target = safeNextPath(savedRedirect) || target;
        }
      } catch (e) {}
      navigate(target, { replace: true });
    } else if (userRole === 'temp_customer') {
      const suffix = safeNext ? `?next=${encodeURIComponent(safeNext)}` : '';
      navigate(`/register${suffix}`, { replace: true });
    }
  }, [userRole, navigate, location.search, safeNext]);

  // 2. 處理 LINE OAuth Callback (/?code=...&state=...)
  useEffect(() => {
    const queryParams = new URLSearchParams(location.search);
    const code = queryParams.get('code');
    const oauthState = queryParams.get('state') || '';

    if (!code) return;

    if (userRole === 'customer') {
      let target = safeNext || '/booking';
      try {
        const savedRedirect =
          sessionStorage.getItem('shiguang_post_login_redirect') ||
          localStorage.getItem('shiguang_post_login_redirect');
        if (savedRedirect) {
          sessionStorage.removeItem('shiguang_post_login_redirect');
          localStorage.removeItem('shiguang_post_login_redirect');
          target = safeNextPath(savedRedirect) || target;
        }
      } catch (e) {}
      navigate(target, { replace: true });
      return;
    }

    if (userRole === 'temp_customer') {
      const suffix = safeNext ? `?next=${encodeURIComponent(safeNext)}` : '';
      navigate(`/register${suffix}`, { replace: true });
      return;
    }

    if (hasProcessedRef.current) return;
    hasProcessedRef.current = true;
    setIsProcessing(true);
    setAuthErrorMsg('');

    // 15 秒處理逾時保護計時器
    const timeoutTimer = setTimeout(() => {
      console.warn('[Home] LINE login handling timed out after 15s');
      navigate(location.pathname, { replace: true });
      setIsProcessing(false);
      setAuthErrorMsg('登入處理逾時，請重新登入。');
    }, 15000);

    const cleanupAndStopProcessing = (errorMsg, isStateInvalid = false) => {
      clearTimeout(timeoutTimer);
      navigate(location.pathname, { replace: true });
      setIsProcessing(false);
      setLineStateInvalid(isStateInvalid);
      if (errorMsg) {
        setAuthErrorMsg(errorMsg);
      }
    };

    const isPreorderLogin = oauthState.startsWith('preorder_');
    setFailedStatePrefix(isPreorderLogin ? 'preorder' : '');

    getBrowserClientInfoAsync()
      .then((clientInfo) => api.post('/auth/line/callback', { code, state: oauthState, clientInfo }))
      .then((res) => {
        clearTimeout(timeoutTimer);
        try {
          sessionStorage.setItem('shiguang_line_fresh_login', '1');
          if (res.data?.token) {
            sessionStorage.setItem('shiguang_auth_token', res.data.token);
          }
        } catch (e) {}

        if (res.data?.isNewUser) {
          window.location.href = '/register';
        } else {
          let target = res.data?.return_path || '';
          try {
            const savedRedirect =
              sessionStorage.getItem('shiguang_post_login_redirect') ||
              localStorage.getItem('shiguang_post_login_redirect');
            sessionStorage.removeItem('shiguang_post_login_redirect');
            localStorage.removeItem('shiguang_post_login_redirect');
            if (!target && savedRedirect) {
              target = savedRedirect;
            }
          } catch (e) {}
          if (!target) {
            target = isPreorderLogin ? '/preorder' : '/booking';
          }
          window.location.href = target;
        }
      })
      .catch(async (err) => {
        console.error('[Home] LINE callback error, checking /auth/me insurance...', err);
        try {
          const freshSession = sessionStorage.getItem('shiguang_line_fresh_login') === '1' ? '1' : '0';
          const meRes = await api.get('/auth/me', {
            params: { fresh_session: freshSession },
          });
          if (meRes.data?.role === 'customer') {
            clearTimeout(timeoutTimer);
            let target = isPreorderLogin ? '/preorder' : '/booking';
            try {
              const savedRedirect =
                sessionStorage.getItem('shiguang_post_login_redirect') ||
                localStorage.getItem('shiguang_post_login_redirect');
              if (savedRedirect) {
                sessionStorage.removeItem('shiguang_post_login_redirect');
                localStorage.removeItem('shiguang_post_login_redirect');
                target = savedRedirect;
              }
            } catch (e) {}
            window.location.href = target;
            return;
          } else if (meRes.data?.role === 'temp_customer') {
            clearTimeout(timeoutTimer);
            window.location.href = '/register';
            return;
          }
        } catch (meErr) {}

        const isStateInvalid = err.response?.data?.code === 'LINE_STATE_INVALID';
        const details = err.response?.data?.details;
        let errorMsg = err.response?.data?.error || err.message || '登入失敗，請重試。';
        if (details && details.error_description) {
          errorMsg = details.error_description;
        } else if (details && details.message) {
          errorMsg = details.message;
        } else if (typeof details === 'string') {
          errorMsg = details;
        }
        cleanupAndStopProcessing(errorMsg, isStateInvalid);
      });

    return () => {
      clearTimeout(timeoutTimer);
    };
  }, [userRole, location.search, location.pathname, navigate]);

  // Load equipment availability for pricing / sell points
  useEffect(() => {
    api.get(`/equipment/availability?date=${todayStr}`)
      .then((res) => {
        setEquipmentConfigs(res.data?.equipments || []);
      })
      .catch(() => {})
      .finally(() => {
        setEquipmentsLoaded(true);
      });
  }, [todayStr]);

  const initiateLineLogin = () => {
    hasProcessedRef.current = false;
    setAuthErrorMsg('');
    setLineStateInvalid(false);
    initiateLineOAuth({
      prefix: failedStatePrefix,
      returnPath: failedStatePrefix === 'preorder' ? '/preorder' : '/booking'
    });
  };

  const hasCodeInUrl = new URLSearchParams(location.search).has('code');
  const showLoading = isProcessing || (hasCodeInUrl && !authErrorMsg && userRole !== 'customer');

  // Today state calculation
  const todayStatus = useMemo(() => {
    const state = dayState(todayStr, sessions, new Date());
    switch (state) {
      case 'ok':
        return { variant: 'ok', text: '今天還有空位' };
      case 'low':
        return { variant: 'low', text: '今天快滿了' };
      case 'full':
        return { variant: 'full', text: '今天已額滿' };
      case 'closed':
      default:
        return { variant: 'full', text: '今天沒有開放' };
    }
  }, [todayStr, sessions]);

  // Discount text
  const discountConfig = useMemo(() => buildDiscountConfig(globalSettings || {}), [globalSettings]);
  const discountTexts = useMemo(() => (hasPricing ? boardDiscountTexts(discountConfig) : null), [hasPricing, discountConfig]);

  // Min hourly rate for smart boards if discount disabled
  const minBoardRate = useMemo(() => {
    const active = equipmentConfigs.filter((e) => e.visibility_status === 'ACTIVE' && e.id !== 'bring_own');
    if (!active.length) return null;
    return Math.min(...active.map((e) => e.hourly_rate));
  }, [equipmentConfigs]);

  const smartBoardSubtext = useMemo(() => {
    if (!hasPricing) {
      return <Skeleton className="h-4 w-32 rounded inline-block" />;
    }
    if (discountTexts) {
      return discountTexts.home;
    }
    if (minBoardRate != null) {
      return `每小時 ${formatMoney(minBoardRate)} 起`;
    }
    if (!equipmentsLoaded) {
      return <Skeleton className="h-4 w-28 rounded inline-block" />;
    }
    return null;
  }, [hasPricing, discountTexts, minBoardRate, equipmentsLoaded]);

  // 6.2 登入處理中
  if (showLoading) {
    return (
      <CustomerLayout bare>
        <div className="sg-peg min-h-[100dvh] grid content-center justify-items-center gap-[18px] px-6 text-center select-none">
          <BrandLogo size="login" />
          <BeadLoader size="md" />
          <h2 className="font-display text-[22px] leading-[1.4] font-bold text-sg-ink">
            正在用 LINE 登入
          </h2>
          <p className="text-[13px] text-sg-muted">
            通常 2 秒內完成，請不要關閉這個畫面
          </p>
        </div>
      </CustomerLayout>
    );
  }

  // 6.1 首頁（未登入）
  return (
    <CustomerLayout bare>
      <div className="flex flex-col min-h-[100dvh]">
        {/* 1. Brand Area */}
        <div className="sg-peg bg-sg-bg border-b border-sg-line grid justify-items-center gap-[10px] text-center px-5 pt-[max(28px,calc(env(safe-area-inset-top)+20px))] pb-[22px]">
          <BrandLogo size="home" />
          <div className="grid gap-[2px]">
            <h1 className="font-display text-[28px] leading-[1.3] font-bold text-sg-ink">
              拾光製所
            </h1>
            <p className="text-[13px] text-sg-muted">
              拼豆時段預約
            </p>
          </div>
        </div>

        {/* 2. Content Area */}
        <div className="grid gap-[10px] px-4 pt-[14px] pb-5 flex-1">
          {authErrorMsg && (
            <div className="grid gap-2">
              <ErrorBanner message={authErrorMsg} />
              {lineStateInvalid && (
                <Button
                  variant="line"
                  size="sm"
                  data-testid="retry-line-login-btn"
                  onClick={initiateLineLogin}
                  className="w-full"
                >
                  再按一次 LINE 登入
                </Button>
              )}
            </div>
          )}

          {globalSettings?.show_announcement && globalSettings?.announcement_text && (
            <AnnouncementBar text={globalSettings.announcement_text} />
          )}

          {globalError && !hasPricing ? (
            <EmptyState
              title="暫時抓不到價格"
              description="請檢查網路後重新整理"
              action={<Button size="sm" onClick={reloadGlobalSettings}>重新整理</Button>}
            />
          ) : !hasPricing || !dayPricing ? (
            <Skeleton className="h-[150px] w-full" />
          ) : (
            <PriceCard
              variant="full"
              selectedDate={todayStr}
              dayPricing={dayPricing}
              globalSettings={globalSettings}
              onOpenPriceInfo={() => setIsPriceInfoOpen(true)}
            />
          )}

          {/* Sell points card */}
          <Card gap={12}>
            <div className="flex items-center gap-2">
              <Grid className="w-[18px] h-[18px] text-sg-brown shrink-0" />
              <div className="text-[14px] font-bold text-sg-ink">
                不限板，不限量，時間內任你拼
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Sparkles className="w-[18px] h-[18px] text-sg-brown shrink-0" />
              <div>
                <div className="text-[14px] font-bold text-sg-ink">
                  智能板可加租
                </div>
                {smartBoardSubtext && (
                  <div className="sg-small">
                    {smartBoardSubtext}
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* Today status pill */}
          <div className="flex justify-center my-1">
            <Pill variant={todayStatus.variant}>
              {todayStatus.text}
            </Pill>
          </div>
        </div>

        {/* 3. Fixed Bottom Area */}
        <div className="sticky bottom-0 z-40 bg-sg-paper border-t border-sg-line px-4 pt-3 pb-[max(18px,env(safe-area-inset-bottom))] grid gap-2">
          <GuestLineLoginButton
            page="home"
            globalSettings={globalSettings}
            returnPath={safeNext || '/booking'}
            onClick={() => {
              hasProcessedRef.current = false;
              setAuthErrorMsg('');
            }}
          />

          {globalSettings?.enable_preview_page !== false && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate('/preview')}
              className="w-full"
            >
              先看看空位
            </Button>
          )}
        </div>
      </div>

      <PriceInfoSheet
        isOpen={isPriceInfoOpen}
        onClose={() => setIsPriceInfoOpen(false)}
        globalSettings={globalSettings}
        dayPricing={dayPricing}
        dateStr={todayStr}
        equipmentConfigs={equipmentConfigs}
        error={globalError}
        onReload={reloadGlobalSettings}
      />
    </CustomerLayout>
  );
}
