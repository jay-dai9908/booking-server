import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import {
  ShieldAlert,
  ShieldCheck,
  KeyRound,
  Copy,
  Check,
  AlertTriangle,
  RefreshCw,
  Lock
} from 'lucide-react';
import api from '../../api/axios';

const EVENT_LABELS = {
  locked: '密碼錯 3 次鎖定',
  unlocked_totp: '驗證器解鎖',
  unlocked_backup: '備用碼解鎖',
  unlocked_cli: '伺服器指令解鎖',
  unlock_blocked: '解鎖失敗達上限封鎖',
  totp_enabled: '啟用驗證器',
  totp_disabled: '停用驗證器',
  totp_regenerated: '更換驗證器',
  backup_codes_regenerated: '重新產生備用碼',
  totp_reset_cli: '伺服器指令重設驗證器'
};

function formatTaipeiTime(isoStr) {
  if (!isoStr) return '';
  try {
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(isoStr));
  } catch {
    return '';
  }
}

function formatTaipeiDateTime(isoStr) {
  if (!isoStr) return '—';
  try {
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(isoStr));
  } catch {
    return '—';
  }
}

function groupSecret(secret) {
  return String(secret || '').replace(/(.{4})/g, '$1 ').trim();
}

export default function AdminLoginGuardCard() {
  const [guard, setGuard] = useState(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [statusMsg, setStatusMsg] = useState('');

  // Setup / backup codes wizard: null | 'qr' | 'confirm' | 'backup_codes'
  const [wizardStep, setWizardStep] = useState(null);
  const [setupData, setSetupData] = useState(null); // { secret, otpauth_uri }
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [backupCodes, setBackupCodes] = useState([]);
  const [copiedKey, setCopiedKey] = useState('');

  // Prompt for current TOTP before replace / regenerate / disable
  const [actionPrompt, setActionPrompt] = useState(null); // { type: 'replace'|'regenerate'|'disable', code, error, busy }
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState('');

  const flashStatus = (msg) => {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(''), 3500);
  };

  const fetchGuard = async () => {
    try {
      const res = await api.get('/auth/admin/guard');
      setGuard(res.data);
      setForbidden(false);
    } catch (err) {
      if (err.response?.status === 403 || err.response?.status === 401) {
        setForbidden(true);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGuard();
  }, []);

  useEffect(() => {
    let active = true;
    if (wizardStep === 'qr' && setupData?.otpauth_uri) {
      QRCode.toDataURL(setupData.otpauth_uri, { width: 200, margin: 2 })
        .then((url) => {
          if (active) setQrDataUrl(url);
        })
        .catch((err) => {
          console.error('Failed to render TOTP QR code:', err);
        });
    } else {
      setQrDataUrl('');
    }
    return () => {
      active = false;
    };
  }, [wizardStep, setupData?.otpauth_uri]);

  if (loading || forbidden || !guard) {
    return null;
  }

  const handleCopy = (text, key) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(''), 2000);
  };

  const handleStartSetup = async (currentCode = null) => {
    setSetupBusy(true);
    setSetupError('');
    try {
      const payload = currentCode ? { code: currentCode.trim() } : {};
      const res = await api.post('/auth/admin/guard/totp/setup', payload);
      setSetupData(res.data);
      setConfirmCode('');
      setConfirmError('');
      setActionPrompt(null);
      setWizardStep('qr');
    } catch (err) {
      const msg = err.response?.data?.error || '產生驗證器設定失敗';
      if (actionPrompt) {
        setActionPrompt(prev => prev ? { ...prev, error: msg, busy: false } : null);
      } else {
        setSetupError(msg);
      }
    } finally {
      setSetupBusy(false);
    }
  };

  const handleConfirmSetup = async (e) => {
    e.preventDefault();
    const clean = confirmCode.trim();
    if (!/^\d{6}$/.test(clean)) {
      setConfirmError('請輸入 6 位數驗證碼');
      return;
    }
    setConfirmBusy(true);
    setConfirmError('');
    try {
      const res = await api.post('/auth/admin/guard/totp/confirm', { code: clean });
      setBackupCodes(res.data?.backup_codes || []);
      setSetupData(null);
      setConfirmCode('');
      setWizardStep('backup_codes');
      fetchGuard();
    } catch (err) {
      setConfirmError(err.response?.data?.error || '驗證碼不正確，請再試一次');
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleActionPromptSubmit = async (e) => {
    e.preventDefault();
    if (!actionPrompt) return;
    const clean = actionPrompt.code.trim();
    if (!/^\d{6}$/.test(clean)) {
      setActionPrompt(prev => ({ ...prev, error: '請輸入目前驗證器上的 6 位數碼' }));
      return;
    }

    if (actionPrompt.type === 'replace') {
      setActionPrompt(prev => ({ ...prev, busy: true, error: '' }));
      await handleStartSetup(clean);
      return;
    }

    setActionPrompt(prev => ({ ...prev, busy: true, error: '' }));
    try {
      if (actionPrompt.type === 'regenerate') {
        const res = await api.post('/auth/admin/guard/backup-codes/regenerate', { code: clean });
        setBackupCodes(res.data?.backup_codes || []);
        setActionPrompt(null);
        setWizardStep('backup_codes');
        fetchGuard();
      } else if (actionPrompt.type === 'disable') {
        await api.post('/auth/admin/guard/totp/disable', { code: clean });
        setActionPrompt(null);
        flashStatus('已停用後台驗證器');
        fetchGuard();
      }
    } catch (err) {
      setActionPrompt(prev => ({
        ...prev,
        busy: false,
        error: err.response?.data?.error || '驗證碼不正確'
      }));
    }
  };

  const events = Array.isArray(guard.recent_events) ? guard.recent_events : [];

  return (
    <div
      data-testid="admin-login-guard-card"
      className="bg-white rounded-2xl shadow-sm border border-[#E8DEC8] p-5 sm:p-6 space-y-5"
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gray-100 pb-4">
        <div>
          <h2 className="text-lg font-bold text-[#3E332B] flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-[#8B5B43] shrink-0" />
            <span>後台登入保護</span>
          </h2>
          <p className="text-xs text-gray-500 mt-1 leading-relaxed">
            10 分鐘內密碼錯 3 次，整個後台登入會鎖住。用手機驗證器的 6 位數碼解鎖。已登入的裝置不受影響。
          </p>
        </div>
        {statusMsg && (
          <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-xl shrink-0">
            <Check className="w-3.5 h-3.5" />
            {statusMsg}
          </span>
        )}
      </div>

      {/* Currently Locked Banner */}
      {guard.locked && (
        <div
          data-testid="guard-locked-banner"
          className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs sm:text-sm font-bold"
        >
          <Lock className="w-4 h-4 text-rose-600 shrink-0" />
          <span>後台登入目前鎖定中（從 {formatTaipeiTime(guard.locked_at)} 起）</span>
        </div>
      )}

      {/* TOTP Broken Alert */}
      {guard.totp_broken && (
        <div
          data-testid="guard-broken-alert"
          className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 rounded-xl bg-rose-50 border border-rose-300 text-rose-900"
        >
          <div className="flex items-center gap-2 text-xs sm:text-sm font-bold">
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>驗證器設定已失效，請重新設定</span>
          </div>
          {!wizardStep && (
            <button
              type="button"
              disabled={setupBusy}
              onClick={() => handleStartSetup()}
              className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              {setupBusy ? '準備中...' : '重新設定驗證器'}
            </button>
          )}
        </div>
      )}

      {/* Unconfigured Orange Prompt */}
      {!guard.totp_enabled && !guard.totp_broken && !wizardStep && (
        <div
          data-testid="guard-unconfigured-alert"
          className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3.5 rounded-xl bg-amber-50 border border-amber-300 text-amber-950"
        >
          <div className="flex items-center gap-2 text-xs sm:text-sm font-bold">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>尚未設定驗證器，鎖定後只能從伺服器解鎖</span>
          </div>
          <button
            type="button"
            disabled={setupBusy}
            onClick={() => handleStartSetup()}
            className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            {setupBusy ? '準備中...' : '設定驗證器'}
          </button>
        </div>
      )}

      {setupError && (
        <p className="text-xs font-bold text-rose-600">{setupError}</p>
      )}

      {/* Configured Summary & Actions */}
      {guard.totp_enabled && !guard.totp_broken && !wizardStep && (
        <div
          data-testid="guard-configured-panel"
          className="bg-[#FAF7F2] border border-[#E8DEC8] rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
        >
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-bold text-[#3E332B]">
              <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>已啟用驗證器保護</span>
              <span className="text-xs font-normal text-[#8C8279]">
                （啟用於 {formatTaipeiDateTime(guard.totp_enabled_at)}）
              </span>
            </div>
            <p className={`text-xs font-bold ${
              (guard.backup_codes_remaining ?? 0) < 3 ? 'text-amber-700' : 'text-[#6D5D52]'
            }`}>
              剩餘備用碼：{guard.backup_codes_remaining ?? 0} 組
              {(guard.backup_codes_remaining ?? 0) < 3 && '（備用碼剩餘不足，建議重新產生）'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setActionPrompt({ type: 'replace', code: '', error: '', busy: false })}
              className="px-3 py-1.5 rounded-xl bg-white border border-[#E8DEC8] hover:bg-[#F2ECE4] text-xs font-bold text-[#3E332B] whitespace-nowrap"
            >
              更換驗證器
            </button>
            <button
              type="button"
              onClick={() => setActionPrompt({ type: 'regenerate', code: '', error: '', busy: false })}
              className="px-3 py-1.5 rounded-xl bg-white border border-[#E8DEC8] hover:bg-[#F2ECE4] text-xs font-bold text-[#3E332B] whitespace-nowrap"
            >
              重新產生備用碼
            </button>
            <button
              type="button"
              onClick={() => setActionPrompt({ type: 'disable', code: '', error: '', busy: false })}
              className="px-3 py-1.5 rounded-xl bg-white border border-rose-200 hover:bg-rose-50 text-xs font-bold text-rose-700 whitespace-nowrap"
            >
              停用
            </button>
          </div>
        </div>
      )}

      {/* Action Prompt (requires current TOTP code) */}
      {actionPrompt && !wizardStep && (
        <form
          onSubmit={handleActionPromptSubmit}
          className="bg-[#FAF7F2] border border-[#E8DEC8] rounded-2xl p-4 space-y-3"
        >
          <div className="text-sm font-bold text-[#3E332B] flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-[#8B5B43]" />
            <span>
              {actionPrompt.type === 'replace' && '更換驗證器：請先輸入目前驗證器的 6 位數碼'}
              {actionPrompt.type === 'regenerate' && '重新產生備用碼：請先輸入目前驗證器的 6 位數碼（舊備用碼將全數作廢）'}
              {actionPrompt.type === 'disable' && '停用驗證器：請先輸入目前驗證器的 6 位數碼'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={actionPrompt.code}
              onChange={(e) => setActionPrompt(prev => ({ ...prev, code: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
              placeholder="6 位數驗證碼"
              className="w-40 px-3 py-2 rounded-xl border border-[#E8DEC8] bg-white font-mono text-sm font-bold text-[#3E332B] outline-none focus:border-[#8B5B43]"
              autoFocus
            />
            <button
              type="submit"
              disabled={actionPrompt.busy}
              className="px-4 py-2 rounded-xl bg-[#8B5B43] hover:bg-[#724834] text-white text-xs font-bold whitespace-nowrap disabled:opacity-50"
            >
              {actionPrompt.busy ? '驗證中...' : '確認'}
            </button>
            <button
              type="button"
              onClick={() => setActionPrompt(null)}
              className="px-3 py-2 rounded-xl border border-gray-300 bg-white hover:bg-gray-50 text-xs font-bold text-gray-600 whitespace-nowrap"
            >
              取消
            </button>
          </div>
          {actionPrompt.error && (
            <p className="text-xs font-bold text-rose-600">{actionPrompt.error}</p>
          )}
        </form>
      )}

      {/* Wizard Step 1: QR Code & Manual Key */}
      {wizardStep === 'qr' && setupData && (
        <div
          data-testid="guard-setup-step-qr"
          className="bg-[#FAF7F2] border border-[#E8DEC8] rounded-2xl p-5 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-[#3E332B]">步驟 1／3：掃描 QR Code 或手動輸入金鑰</h3>
            <button
              type="button"
              onClick={() => {
                setWizardStep(null);
                setSetupData(null);
              }}
              className="text-xs font-bold text-gray-500 hover:text-gray-700 whitespace-nowrap"
            >
              取消
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 items-center">
            <div className="flex flex-col items-center gap-2">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="後台登入驗證器 QR Code"
                  className="w-44 h-44 rounded-xl border border-[#E8DEC8] bg-white p-2"
                />
              ) : (
                <div className="w-44 h-44 rounded-xl border border-[#E8DEC8] bg-white flex items-center justify-center text-xs text-gray-400">
                  產生 QR 中...
                </div>
              )}
              <span className="text-[11px] text-[#8C8279]">使用 Google Authenticator 等驗證器 App 掃描</span>
            </div>

            <div className="space-y-3">
              <div>
                <div className="text-xs font-bold text-[#6D5D52] mb-1">手動輸入金鑰</div>
                <div className="p-3 rounded-xl bg-white border border-[#E8DEC8] font-mono text-sm font-bold text-[#3E332B] break-all">
                  {groupSecret(setupData.secret)}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleCopy(setupData.secret, 'secret')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border border-[#E8DEC8] hover:bg-[#F2ECE4] text-xs font-bold text-[#3E332B] whitespace-nowrap"
                >
                  {copiedKey === 'secret' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedKey === 'secret' ? '已複製金鑰' : '複製金鑰'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setWizardStep('confirm')}
                  className="px-4 py-1.5 rounded-xl bg-[#8B5B43] hover:bg-[#724834] text-white text-xs font-bold whitespace-nowrap"
                >
                  下一步
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Wizard Step 2: Confirm 6-digit TOTP */}
      {wizardStep === 'confirm' && (
        <form
          onSubmit={handleConfirmSetup}
          data-testid="guard-setup-step-confirm"
          className="bg-[#FAF7F2] border border-[#E8DEC8] rounded-2xl p-5 space-y-4"
        >
          <h3 className="text-sm font-bold text-[#3E332B]">步驟 2／3：輸入驗證器上的 6 位數碼確認</h3>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={confirmCode}
              onChange={(e) => setConfirmCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="輸入 6 位數碼"
              className="w-44 px-3.5 py-2 rounded-xl border border-[#E8DEC8] bg-white font-mono text-base font-bold text-[#3E332B] outline-none focus:border-[#8B5B43]"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setWizardStep('qr')}
              className="px-3.5 py-2 rounded-xl border border-gray-300 bg-white hover:bg-gray-50 text-xs font-bold text-gray-700 whitespace-nowrap"
            >
              上一步
            </button>
            <button
              type="submit"
              disabled={confirmBusy}
              className="px-4 py-2 rounded-xl bg-[#8B5B43] hover:bg-[#724834] text-white text-xs font-bold whitespace-nowrap disabled:opacity-50"
            >
              {confirmBusy ? '確認中...' : '確認啟用'}
            </button>
          </div>
          {confirmError && (
            <p className="text-xs font-bold text-rose-600">{confirmError}</p>
          )}
        </form>
      )}

      {/* Wizard Step 3: Show 8 Backup Codes ONCE */}
      {wizardStep === 'backup_codes' && (
        <div
          data-testid="guard-backup-codes-panel"
          className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-5 space-y-4"
        >
          <div className="space-y-1">
            <h3 className="text-sm font-bold text-amber-950">步驟 3／3：請保存這 8 組備用碼</h3>
            <p className="text-xs font-bold text-rose-700">
              這些備用碼只會顯示這一次，請抄下來或印出來收好。每組只能用一次。
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {backupCodes.map((code, idx) => (
              <div
                key={code}
                className="px-3 py-2 rounded-xl bg-white border border-amber-200 font-mono text-sm font-bold text-[#3E332B] flex items-center justify-between"
              >
                <span className="text-[11px] text-gray-400 mr-2">#{idx + 1}</span>
                <span>{code}</span>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => handleCopy(backupCodes.join('\n'), 'backup')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white border border-amber-300 hover:bg-amber-100 text-xs font-bold text-amber-950 whitespace-nowrap"
            >
              {copiedKey === 'backup' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedKey === 'backup' ? '已複製全部' : '複製全部'}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setWizardStep(null);
                setBackupCodes([]);
                fetchGuard();
              }}
              className="px-4 py-2 rounded-xl bg-[#8B5B43] hover:bg-[#724834] text-white text-xs font-bold whitespace-nowrap"
            >
              我已收好
            </button>
          </div>
        </div>
      )}

      {/* Recent Lock & Unlock Events Table */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-[#3E332B]">最近鎖定與解鎖紀錄（最多 20 筆）</h3>
          <button
            type="button"
            onClick={fetchGuard}
            className="inline-flex items-center gap-1 text-xs font-bold text-[#8B5B43] hover:underline whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>重新整理</span>
          </button>
        </div>

        {events.length === 0 ? (
          <div className="text-xs text-gray-400 bg-[#FAF7F2] border border-[#E8DEC8] rounded-xl px-4 py-4 text-center">
            尚無鎖定或解鎖紀錄
          </div>
        ) : (
          <div className="overflow-x-auto border border-[#E8DEC8] rounded-xl">
            <table className="w-full text-left text-xs whitespace-nowrap">
              <thead>
                <tr className="bg-[#FAF7F2] text-[#8C8279] border-b border-[#E8DEC8]">
                  <th className="px-3 py-2.5 font-semibold">時間</th>
                  <th className="px-3 py-2.5 font-semibold">事件</th>
                  <th className="px-3 py-2.5 font-semibold">IP</th>
                  <th className="px-3 py-2.5 font-semibold">裝置</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {events.map((ev) => (
                  <tr key={ev.id} className="hover:bg-[#FAF7F2]/60">
                    <td className="px-3 py-2 text-gray-700 font-mono">
                      {formatTaipeiDateTime(ev.created_at)}
                    </td>
                    <td className="px-3 py-2 font-bold text-[#3E332B]">
                      {EVENT_LABELS[ev.type] || ev.type}
                    </td>
                    <td className="px-3 py-2 font-mono text-gray-600">
                      {ev.ip || '—'}
                    </td>
                    <td className="px-3 py-2 text-gray-500 max-w-[220px] truncate" title={ev.user_agent || ''}>
                      {ev.user_agent || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
