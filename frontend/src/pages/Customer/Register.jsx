import React, { useState } from 'react';
import { Check } from 'lucide-react';
import CustomerLayout from '../../components/customer/CustomerLayout';
import AppBar from '../../components/customer/AppBar';
import BrandLogo from '../../components/customer/BrandLogo';
import Field from '../../components/customer/Field';
import Button from '../../components/customer/Button';
import { ErrorBanner } from '../../components/customer/Banners';
import api from '../../api/axios';
import { getBrowserClientInfoAsync } from '../../utils/clientInfo';

function formatPhoneInput(digits) {
  // Format as 4-3-3: 0912 345 678
  const clean = digits.replace(/\D/g, '').slice(0, 10);
  if (clean.length <= 4) return clean;
  if (clean.length <= 7) return `${clean.slice(0, 4)} ${clean.slice(4)}`;
  return `${clean.slice(0, 4)} ${clean.slice(4, 7)} ${clean.slice(7)}`;
}

export default function Register({ setUserRole }) {
  const [name, setName] = useState('');
  const [phoneDisplay, setPhoneDisplay] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [backendError, setBackendError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

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

    try {
      const clientInfo = await getBrowserClientInfoAsync();
      const res = await api.post('/auth/register', {
        name: name.trim(),
        phone: rawPhone,
        clientInfo,
      });

      let target = '/booking';
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
          target = savedRedirect;
        }
      } catch (err) {}

      if (setUserRole) setUserRole('customer');
      window.location.href = target;
    } catch (err) {
      console.error('Registration failed', err);
      setBackendError(err.response?.data?.error || err.response?.data?.message || '註冊失敗，請重試');
    } finally {
      setIsSubmitting(false);
    }
  };

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

          {backendError && <ErrorBanner message={backendError} />}
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
    </CustomerLayout>
  );
}
