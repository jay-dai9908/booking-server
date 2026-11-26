import React, { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check } from 'lucide-react';
import CustomerLayout from '../../components/customer/CustomerLayout';
import AppBar from '../../components/customer/AppBar';
import Field from '../../components/customer/Field';
import Button from '../../components/customer/Button';
import BottomSheet from '../../components/customer/BottomSheet';
import { ErrorBanner, InfoBanner } from '../../components/customer/Banners';
import api from '../../api/axios';
import { getBrowserClientInfoAsync } from '../../utils/clientInfo';
import { initiateLineOAuth } from '../../utils/lineAuth';
import { safeNextPath } from '../../utils/customer/nextPath';
import { useGlobalSettings } from '../../hooks/customer/useGlobalSettings';

export const DEFAULT_PRIVACY_NOTICE =
  '拾光製所會蒐集你的稱呼、手機號碼和 LINE 帳號基本資料，用在預約與到店核對、聯繫預約相關事項、會員卡券與消費紀錄。資料只在本店預約系統使用，不提供給第三方（法律規定除外），保存到你要求刪除為止。你可以隨時用 LINE 聯絡我們查詢、更正或刪除資料。不提供手機號碼將無法完成線上預約。';

function formatPhoneInput(digits) {
  // Format as 4-3-3: 09xx xxx xxx
  const clean = digits.replace(/\D/g, '').slice(0, 10);
  if (clean.length <= 4) return clean;
  if (clean.length <= 7) return `${clean.slice(0, 4)} ${clean.slice(4)}`;
  return `${clean.slice(0, 4)} ${clean.slice(4, 7)} ${clean.slice(7)}`;
}

export default function Register({ setUserRole }) {
  const [searchParams] = useSearchParams();
  const safeNext = useMemo(() => safeNextPath(searchParams.get('next')), [searchParams]);
  const { settings: globalSettings } = useGlobalSettings();

  const [name, setName] = useState('');
  const [phoneDisplay, setPhoneDisplay] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [backendError, setBackendError] = useState('');
  const [tempExpired, setTempExpired] = useState(false);
  const [showPrivacySheet, setShowPrivacySheet] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successTarget, setSuccessTarget] = useState(null);

  const privacyText = useMemo(() => {
    const custom = globalSettings?.privacy_notice_text;
    if (typeof custom === 'string' && custom.trim()) {
      return custom.trim();
    }
    return DEFAULT_PRIVACY_NOTICE;
  }, [globalSettings]);

  const rawPhone = phoneDisplay.replace(/\D/g, '');

  const validatePhone = (digits) => {
    if (!digits) return '';
    if (!/^09\d{8}$/.test(digits)) {
      return '請輸入 09 開頭的 10 位手機號碼';
    }
    return '';
  };

  const handlePhoneChange = (e) => {
    const formatted = formatPhoneInput(e.target.value);
    setPhoneDisplay(formatted);
    const digits = formatted.replace(/\D/g, '');
    if (phoneError && (/^09\d{8}$/.test(digits) || !digits)) {
      setPhoneError('');
    }
  };

  const handlePhoneBlur = () => {
    if (rawPhone) {
      setPhoneError(validatePhone(rawPhone));
    }
  };

  const isFormValid = name.trim().length > 0 && /^09\d{8}$/.test(rawPhone);

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    const err = validatePhone(rawPhone);
    if (err) {
      setPhoneError(err);
      return;
    }
    if (!name.trim()) return;

    setIsSubmitting(true);
    setBackendError('');
    setTempExpired(false);

    try {
      const clientInfo = await getBrowserClientInfoAsync();
      const res = await api.post('/auth/register', {
        name: name.trim(),
        phone: rawPhone,
        clientInfo,
      });

      let target = safeNext || '/booking';
      try {
        sessionStorage.setItem('shiguang_line_fresh_login', '1');
        if (res.data?.token) {
          sessionStorage.setItem('shiguang_auth_token', res.data.token);
        }
        const savedRedirect =
          sessionStorage.getItem('shiguang_post_login_redirect') ||
          localStorage.getItem('shiguang_post_login_redirect');
        if (savedRedirect) {
          sessionStorage.removeItem('shiguang_post_login_redirect');
          localStorage.removeItem('shiguang_post_login_redirect');
          target = safeNextPath(savedRedirect) || target;
        }
      } catch (storageErr) {}

      setSuccessTarget(target);
    } catch (err) {
      console.error('Registration failed', err);
      const status = err.response?.status;
      if (status === 401) {
        setTempExpired(true);
      }
      const rawMsg = err.response?.data?.error || err.response?.data?.message || '';
      const safeZhMsg = rawMsg && /[\u4e00-\u9fff]/.test(rawMsg)
        ? rawMsg
        : (status === 401 ? '登入已過期，請重新用 LINE 登入' : '註冊失敗，請稍後再試');
      setBackendError(safeZhMsg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleContinueAfterSuccess = () => {
    if (setUserRole) setUserRole('customer');
    window.location.href = successTarget || safeNext || '/booking';
  };

  if (successTarget) {
    return (
      <CustomerLayout
        header={
          <AppBar
            variant="brandTwoLine"
            subtitle="綁定會員"
          />
        }
      >
        <div className="flex flex-col flex-1 justify-between">
          <div className="py-6 space-y-4">
            <div className="mx-auto w-14 h-14 rounded-full bg-sg-sage-soft text-sg-sage-ink flex items-center justify-center">
              <Check className="w-7 h-7 stroke-[2.5]" />
            </div>
            <div className="text-center">
              <h2 className="font-display text-[20px] leading-[1.35] font-bold text-sg-ink">
                註冊成功，已完成會員綁定
              </h2>
              <p className="text-[13px] text-sg-muted mt-1">
                現在可以開始預約時段或查看會員資料
              </p>
            </div>
            <InfoBanner>
              如果你之前在店裡留過電話，店員確認後會把舊紀錄合併到這個帳號
            </InfoBanner>
          </div>

          <div className="sticky bottom-0 z-40 bg-sg-paper border-t border-sg-line px-4 pt-3 pb-[max(18px,env(safe-area-inset-bottom))]">
            <Button
              variant="primary"
              size="md"
              onClick={handleContinueAfterSuccess}
              className="w-full"
            >
              開始預約
            </Button>
          </div>
        </div>
      </CustomerLayout>
    );
  }

  return (
    <CustomerLayout
      header={
        <AppBar
          variant="brandTwoLine"
          subtitle="綁定會員"
        />
      }
    >
      <div className="flex flex-col flex-1">
        {/* Welcome Area */}
        <div className="py-2 text-center">
          <h2 className="font-display text-[20px] leading-[1.35] font-bold text-sg-ink">
            歡迎第一次來
          </h2>
          <p className="text-[13px] text-sg-muted mt-1">
            留下稱呼和手機，就能開始預約
          </p>
        </div>

        {/* 2. Form Area */}
        <form onSubmit={handleSubmit} className="grid gap-4 pt-2 pb-5 flex-1">
          {/* Connection status bar */}
          <div className="flex items-center gap-[10px] rounded-[14px] border border-sg-line bg-sg-paper px-3 py-[10px]">
            <span className="flex-1 text-[14px] font-bold text-sg-ink">
              已連結 LINE 帳號
            </span>
            <Check className="w-[18px] h-[18px] text-sg-sage-ink stroke-[2.5]" />
          </div>

          {/* Name Field */}
          <Field
            label="怎麼稱呼你"
            required
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：小美"
            autoComplete="nickname"
            maxLength={20}
          />

          {/* Phone Field */}
          <Field
            label="手機號碼"
            required
            type="tel"
            inputMode="numeric"
            value={phoneDisplay}
            onChange={handlePhoneChange}
            onBlur={handlePhoneBlur}
            placeholder="0912 345 678"
            autoComplete="tel-national"
            helper="用於到店核對預約和臨時通知"
            error={phoneError}
          />

          <div className="text-[12.5px] text-sg-muted leading-relaxed -mt-1">
            送出即表示你同意我們依個資告知使用你的稱呼和手機。{' '}
            <button
              type="button"
              data-testid="open-privacy-notice-btn"
              onClick={() => setShowPrivacySheet(true)}
              className="font-bold text-sg-brown underline underline-offset-2"
            >
              查看個資告知
            </button>
          </div>

          {backendError && (
            <div className="grid gap-2">
              <ErrorBanner message={backendError} />
              {tempExpired && (
                <Button
                  type="button"
                  variant="line"
                  size="md"
                  onClick={() => initiateLineOAuth({ returnPath: safeNext || '/booking' })}
                  className="w-full"
                >
                  重新用 LINE 登入
                </Button>
              )}
            </div>
          )}
        </form>

        {/* 3. Fixed Bottom Area */}
        <div className="sticky bottom-0 z-40 bg-sg-paper border-t border-sg-line px-4 pt-3 pb-[max(18px,env(safe-area-inset-bottom))]">
          <Button
            variant="primary"
            size="md"
            loading={isSubmitting}
            disabled={!isFormValid || isSubmitting}
            onClick={handleSubmit}
            className="w-full"
          >
            完成綁定，開始預約
          </Button>
        </div>
      </div>

      <BottomSheet
        isOpen={showPrivacySheet}
        onClose={() => setShowPrivacySheet(false)}
        title="個人資料蒐集告知"
      >
        <p
          data-testid="privacy-notice-content"
          className="text-[14px] leading-[1.6] text-sg-ink whitespace-pre-line"
        >
          {privacyText}
        </p>
      </BottomSheet>
    </CustomerLayout>
  );
}
