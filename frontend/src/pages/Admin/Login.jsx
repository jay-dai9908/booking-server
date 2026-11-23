import React, { useState, useEffect } from 'react';
import { Lock, ArrowRight, Eye, EyeOff, ShieldAlert, CheckCircle2 } from 'lucide-react';
import api from '../../api/axios';

function AdminLogin({ setUserRole }) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const [lockState, setLockState] = useState({ locked: false, canUnlockWithCode: false });
  const [unlockCode, setUnlockCode] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [unlockError, setUnlockError] = useState('');
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [unlockedNotice, setUnlockedNotice] = useState('');

  const fetchLockStatus = async () => {
    try {
      const res = await api.get('/auth/admin/lock-status');
      if (res.data?.locked) {
        setLockState({
          locked: true,
          canUnlockWithCode: Boolean(res.data.can_unlock_with_code)
        });
        setError('');
      } else {
        setLockState({ locked: false, canUnlockWithCode: Boolean(res.data?.can_unlock_with_code) });
      }
    } catch {
      // ignore initial status fetch error
    }
  };

  useEffect(() => {
    fetchLockStatus();
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    setUnlockedNotice('');
    const cleanPass = password.trim();
    if (!cleanPass) {
      setError('請輸入管理員或員工密碼');
      setIsLoading(false);
      return;
    }

    try {
      const res = await api.post('/auth/admin/login', { password: cleanPass });
      if (res.data?.token) {
        try {
          sessionStorage.setItem('shiguang_auth_token', res.data.token);
        } catch (e) {}
      }
      setUserRole('admin');
      window.location.href = '/admin/sessions';
    } catch (err) {
      const status = err.response?.status;
      if (status === 423 || err.response?.data?.code === 'ADMIN_LOCKED') {
        setError('');
        setPassword('');
        setUnlockError('');
        setUnlockCode('');
        await fetchLockStatus();
        setLockState(prev => ({ ...prev, locked: true }));
        setIsLoading(false);
        return;
      }
      const serverMsg = err.response?.data?.error;
      if (serverMsg) {
        setError(serverMsg);
      } else if (!err.response || status >= 500) {
        setError(`伺服器連線異常或後端啟動中 (HTTP ${status || '斷線'})，請確認後端 PM2 狀態`);
      } else {
        setError('密碼錯誤，請重新輸入');
      }
      setIsLoading(false);
    }
  };

  const handleUnlock = async (e) => {
    e.preventDefault();
    const clean = unlockCode.trim();
    if (!clean) {
      setUnlockError(useBackupCode ? '請輸入備用碼' : '請輸入 6 位數驗證碼');
      return;
    }
    setIsUnlocking(true);
    setUnlockError('');
    try {
      await api.post('/auth/admin/unlock', { code: clean });
      setLockState({ locked: false, canUnlockWithCode: false });
      setUnlockCode('');
      setUseBackupCode(false);
      setUnlockError('');
      setError('');
      setUnlockedNotice('已解鎖，請重新輸入密碼登入');
    } catch (err) {
      const status = err.response?.status;
      const code = err.response?.data?.code;
      if (status === 401) {
        setUnlockError('驗證碼不正確');
      } else if (status === 429) {
        setUnlockError('嘗試太多次，請 10 分鐘後再試');
      } else if (status === 409 && code === 'NOT_LOCKED') {
        setLockState({ locked: false, canUnlockWithCode: false });
        setUnlockedNotice('已解鎖，請重新輸入密碼登入');
      } else if (status === 409 && code === 'TOTP_NOT_CONFIGURED') {
        setLockState({ locked: true, canUnlockWithCode: false });
      } else {
        setUnlockError(err.response?.data?.error || '解鎖失敗，請重試');
      }
    } finally {
      setIsUnlocking(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-[#F7F4F0] p-4">
      {/* Minimalist Card */}
      <div className="bg-white p-8 rounded-[24px] shadow-[0_12px_32px_rgba(139,91,67,0.08)] max-w-sm w-full transition-all duration-300">
        <div className="flex justify-center mb-6">
          <img src="/logo.png" alt="拾光製所 Logo" className="w-20 h-20 object-cover rounded-full shadow-sm ring-4 ring-[#F9F7F3]" />
        </div>

        {lockState.locked ? (
          <div data-testid="admin-lock-screen" className="space-y-5">
            <div className="text-center space-y-2">
              <div className="mx-auto w-12 h-12 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center">
                <ShieldAlert className="w-6 h-6" />
              </div>
              <h2 className="text-2xl font-bold text-[#3E332B]">後台已鎖定</h2>
              {lockState.canUnlockWithCode ? (
                <p className="text-[#8C8279] text-sm">
                  {useBackupCode ? '請輸入一次性備用碼解鎖' : '請輸入驗證器上的 6 位數碼解鎖'}
                </p>
              ) : (
                <p className="text-rose-700 text-sm font-medium leading-relaxed pt-1">
                  後台已鎖定。尚未設定驗證器，請聯絡店主從伺服器解鎖。
                </p>
              )}
            </div>

            {lockState.canUnlockWithCode && (
              <form onSubmit={handleUnlock} className="space-y-4">
                {unlockError && (
                  <div className="bg-[#FDF3F1] border border-[#F2D6D3] text-[#B24F45] p-3 rounded-xl text-sm flex items-center justify-center font-medium">
                    {unlockError}
                  </div>
                )}

                <input
                  data-testid="admin-unlock-input"
                  type="text"
                  inputMode={useBackupCode ? 'text' : 'numeric'}
                  autoComplete={useBackupCode ? 'off' : 'one-time-code'}
                  maxLength={useBackupCode ? 20 : 6}
                  value={unlockCode}
                  onChange={(e) => {
                    const val = e.target.value;
                    setUnlockCode(useBackupCode ? val : val.replace(/\D/g, '').slice(0, 6));
                  }}
                  placeholder={useBackupCode ? '輸入備用碼（例：ABCDE-23456）' : '請輸入 6 位數驗證碼'}
                  className="w-full px-4 py-3 bg-white border border-[#D5CFC9] rounded-xl text-[#3E332B] placeholder-[#A8A19A] focus:border-[#8B5B43] focus:ring-1 focus:ring-[#8B5B43] outline-none transition-all font-mono text-center text-lg tracking-widest"
                  autoFocus
                />

                <button
                  data-testid="admin-unlock-submit"
                  type="submit"
                  disabled={isUnlocking}
                  className="w-full flex items-center justify-center gap-2 bg-[#8B5B43] hover:bg-[#A67C52] text-white font-bold py-3 px-4 rounded-xl transition-colors duration-200 disabled:opacity-70"
                >
                  {isUnlocking ? '解鎖中...' : '解鎖'}
                </button>

                <div className="text-center">
                  <button
                    data-testid="admin-unlock-use-backup"
                    type="button"
                    onClick={() => {
                      setUseBackupCode(prev => !prev);
                      setUnlockCode('');
                      setUnlockError('');
                    }}
                    className="text-xs font-bold text-[#8B5B43] hover:underline"
                  >
                    {useBackupCode ? '改回輸入驗證器 6 位數碼' : '改用備用碼'}
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : (
          <>
            <h2 className="text-2xl font-bold text-[#3E332B] mb-2 text-center">拾光製所 系統管理中心</h2>
            <p className="text-[#8C8279] mb-8 text-center text-sm">請輸入最高管理員或員工密碼</p>

            {unlockedNotice && (
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 p-3 rounded-xl mb-6 text-sm flex items-center justify-center gap-2 font-medium">
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
                <span>{unlockedNotice}</span>
              </div>
            )}

            {error && (
              <div className="bg-[#FDF3F1] border border-[#F2D6D3] text-[#B24F45] p-3 rounded-xl mb-6 text-sm flex items-center justify-center font-medium">
                {error}
              </div>
            )}

            <form onSubmit={handleLogin} className="space-y-5">
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Lock className="h-5 w-5 text-[#A8A19A] group-focus-within:text-[#8B5B43] transition-colors" />
                </div>
                <input 
                  type={showPassword ? 'text' : 'password'} 
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-11 pr-11 py-3 bg-white border border-[#D5CFC9] rounded-xl text-[#3E332B] placeholder-[#A8A19A] focus:border-[#8B5B43] focus:ring-1 focus:ring-[#8B5B43] outline-none transition-all font-mono"
                  placeholder="請輸入密碼"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-[#A8A19A] hover:text-[#3E332B] transition-colors"
                  title={showPassword ? '隱藏密碼' : '顯示密碼'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <button 
                type="submit"
                disabled={isLoading}
                className="w-full flex items-center justify-center gap-2 bg-[#8B5B43] hover:bg-[#A67C52] text-white font-bold py-3 px-4 rounded-xl transition-colors duration-200 disabled:opacity-70"
              >
                {isLoading ? '驗證中...' : '安全登入'}
                {!isLoading && <ArrowRight className="w-5 h-5" />}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

export default AdminLogin;
