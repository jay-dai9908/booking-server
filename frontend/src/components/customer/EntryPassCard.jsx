import React, { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { CheckCircle2, QrCode as QrIcon } from 'lucide-react';
import Button from './Button';
import { showCustomerToast } from './Toast';
import { formatPhone } from '../../utils/customer/format';
import api from '../../api/axios';

function formatCountdown(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

function formatCheckinTime(isoStr) {
  if (!isoStr) return '';
  try {
    const dt = new Date(isoStr);
    // 台北時間顯示
    const timeStr = dt.toLocaleTimeString('zh-TW', {
      timeZone: 'Asia/Taipei',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    return timeStr;
  } catch {
    return '';
  }
}

function SelfServiceReminderList({ ironText }) {
  return (
    <div className="rounded-[12px] bg-white/60 border border-sg-line/60 p-3 text-[12.5px] text-sg-muted grid gap-1">
      <div className="font-bold text-sg-ink text-[13px] mb-0.5">半自助時段提醒</div>
      <div>• <b>對象：</b>僅限已經會玩拼豆的朋友</div>
      <div>• <b>教學：</b>當天部分時段沒有店員，無法現場教學</div>
      <div>• <b>熨燙：</b>{ironText || '店員會在今天下午到店協助熨燙'}。完成後請放在熨燙區托盤上</div>
      <div>• <b>進場：</b>憑預約條碼或電話在門口報到機報到，最早可提前 30 分鐘進場</div>
    </div>
  );
}

/**
 * EntryPassCard (Round 26 Item 4)
 * 顧客手機進場條碼卡片：
 * confirmed: 付款已確認，倒數/說明進場時間
 * open: 顯示動態條碼、倒數 5 分鐘自動刷新、防休眠、電話備援
 * in: 顯示已進場時間、座位、營業結束時間、LINE/熨燙資訊、再次進門條碼切換
 * ended: 今天的使用時間已結束
 */
export default function EntryPassCard({
  bookingRef,
  reservation,
  customerPhone,
  onCheckInSuccess
}) {
  const [entryData, setEntryData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showQr, setShowQr] = useState(false);
  const [countdownSec, setCountdownSec] = useState(300);

  const canvasRef = useRef(null);
  const isMountedRef = useRef(true);
  const prevStateRef = useRef(null);
  const refreshingRef = useRef(false);

  // 1. 抓取進場資訊 API
  const fetchPass = async ({ silent = false } = {}) => {
    if (!bookingRef) return;
    if (!silent && !entryData) setLoading(true);
    try {
      const res = await api.get(`/reservations/${bookingRef}/entry`);
      const data = res.data;
      if (!isMountedRef.current) return;

      // 偵測狀態由非 in 轉為 in 時切換畫面並顯示提示
      if (prevStateRef.current && prevStateRef.current !== 'in' && data.state === 'in') {
        showCustomerToast('報到成功，歡迎光臨', { type: 'success' });
        onCheckInSuccess?.();
      }
      prevStateRef.current = data.state;
      setEntryData(data);

      if (data.code_expires_at) {
        const nowSec = Math.floor(Date.now() / 1000);
        setCountdownSec(Math.max(0, data.code_expires_at - nowSec));
      }
    } catch (err) {
      console.error('Failed to fetch entry pass:', err);
    } finally {
      if (isMountedRef.current && !silent) {
        setLoading(false);
      }
      refreshingRef.current = false;
    }
  };

  // 初始載入
  useEffect(() => {
    isMountedRef.current = true;
    fetchPass();
    return () => {
      isMountedRef.current = false;
    };
  }, [bookingRef]);

  // 2. 輪詢邏輯：confirmed 或 open 每 5 秒查一次；in 改為每 60 秒查一次；切到背景時暫停
  useEffect(() => {
    if (!entryData?.state) return;
    const currentState = entryData.state;
    const shouldPoll = currentState === 'confirmed' || currentState === 'open' || currentState === 'in';
    if (!shouldPoll) return;

    const intervalMs = currentState === 'in' ? 60000 : 5000;
    let pollTimer = null;

    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      fetchPass({ silent: true });
    };

    pollTimer = setInterval(tick, intervalMs);

    const handleVisibility = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'visible') {
        tick();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearInterval(pollTimer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [entryData?.state]);

  // 3. 倒數計時器與到期前 5 秒向伺服器換新
  useEffect(() => {
    if (!entryData?.code_expires_at) return;
    const isBarcodeVisible = entryData.state === 'open' || (entryData.state === 'in' && showQr);
    if (!isBarcodeVisible) return;

    const timer = setInterval(() => {
      const nowSec = Math.floor(Date.now() / 1000);
      const remaining = Math.max(0, entryData.code_expires_at - nowSec);
      setCountdownSec(remaining);

      // 到期前 5 秒向伺服器換新的一組
      if (remaining <= 5 && !refreshingRef.current) {
        refreshingRef.current = true;
        fetchPass({ silent: true });
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [entryData?.code_expires_at, entryData?.state, showQr]);

  // 4. 繪製 QR Canvas（至少 200px 寬度，四周留白）
  useEffect(() => {
    const isBarcodeVisible = entryData?.state === 'open' || (entryData?.state === 'in' && showQr);
    if (!canvasRef.current || !entryData?.code || !isBarcodeVisible) return;

    QRCode.toCanvas(canvasRef.current, entryData.code, {
      width: 220,
      margin: 2,
      color: {
        dark: '#2E2620',
        light: '#FFFFFF'
      }
    }).catch((err) => {
      console.error('Failed to draw QR canvas:', err);
    });
  }, [entryData?.code, entryData?.state, showQr]);

  // 5. 螢幕防休眠（Wake Lock API）
  useEffect(() => {
    const isBarcodeVisible = entryData?.state === 'open' || (entryData?.state === 'in' && showQr);
    if (!isBarcodeVisible) return;

    let wakeLock = null;
    if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
      navigator.wakeLock
        .request('screen')
        .then((w) => {
          wakeLock = w;
        })
        .catch(() => {});
    }
    return () => {
      if (wakeLock) {
        wakeLock.release().catch(() => {});
      }
    };
  }, [entryData?.state, showQr]);

  if (loading && !entryData) {
    return (
      <div className="rounded-[16px] border border-sg-line bg-sg-paper p-4 text-center text-sg-muted text-[13px] animate-pulse">
        載入進場資訊中...
      </div>
    );
  }

  if (!entryData) return null;

  const phoneDisplay = formatPhone(
    customerPhone || reservation?.customer_phone || reservation?.user?.phone || '0912-345-678'
  );

  // 狀態渲染
  if (entryData.state === 'confirmed') {
    return (
      <div
        data-testid={`entry-pass-confirmed-${bookingRef}`}
        className="rounded-[16px] border border-sg-sage bg-sg-sage-soft p-4 grid gap-3 text-sg-ink"
      >
        <div className="flex items-center gap-1.5 font-bold text-[17px] text-sg-sage-ink">
          付款已確認
        </div>
        <div>
          <div className="text-[20px] font-bold font-num text-sg-ink">
            當天 {entryData.open_at || '12:30'} 起可進場
          </div>
          <div className="text-[13px] text-sg-muted mt-1 leading-relaxed">
            預約 {entryData.start || reservation?.start_time} 開始，最早可提前 30 分鐘。進場條碼到時候會出現在這裡。
          </div>
        </div>
        <SelfServiceReminderList ironText={entryData.iron_text} />
      </div>
    );
  }

  if (entryData.state === 'open') {
    return (
      <div
        data-testid={`entry-pass-open-${bookingRef}`}
        className="rounded-[16px] border border-sg-line bg-white p-5 grid gap-3.5 text-center justify-items-center text-sg-ink shadow-sm"
      >
        <div className="text-[18px] font-bold tracking-wide text-sg-ink">進場條碼</div>

        <div className="p-2.5 bg-white rounded-[14px] border border-sg-line shadow-inner flex flex-col items-center">
          <canvas
            ref={canvasRef}
            data-testid="entry-pass-qr-canvas"
            style={{ width: 220, height: 220 }}
          />
        </div>

        <div className="text-[14px] font-num text-sg-muted flex items-center justify-center gap-1.5">
          <span className="font-extrabold text-sg-brown" data-testid="entry-pass-countdown">
            {formatCountdown(countdownSec)}
          </span>{' '}
          後自動更新
        </div>

        <div className="text-[13px] text-sg-muted leading-relaxed max-w-[320px]">
          把條碼對準門口報到機下方的掃碼口。條碼每 5 分鐘換一組，截圖會失效。
        </div>

        <div className="text-[12.5px] text-sg-muted">
          沒辦法掃碼？在報到機按「電話報到」，輸入{' '}
          <span className="font-num font-bold text-sg-ink">{phoneDisplay}</span>
        </div>

        <SelfServiceReminderList ironText={entryData.iron_text} />
      </div>
    );
  }

  if (entryData.state === 'in') {
    const hasSeats = Array.isArray(entryData.seats) && entryData.seats.length > 0;
    const seatText = hasSeats ? entryData.seats.join('、') : '請自由選擇空位';
    const zoneText = entryData.zone ? `你的座位 · ${entryData.zone}` : '你的座位';

    return (
      <div
        data-testid={`entry-pass-in-${bookingRef}`}
        className="rounded-[16px] border border-sg-sage bg-sg-sage-soft p-5 grid gap-4 text-sg-ink shadow-sm"
      >
        <div className="flex items-center justify-between">
          <div className="font-bold text-[18px] text-sg-sage-ink flex items-center gap-1.5">
            <CheckCircle2 className="w-5 h-5 text-sg-sage-ink" />
            已進場 {formatCheckinTime(entryData.first_checkin_at)}
          </div>
        </div>

        <div className="rounded-[12px] bg-white/75 border border-sg-sage/40 p-3.5 grid gap-1">
          <div className="text-[13px] text-sg-muted">{zoneText}</div>
          <div
            data-testid="entry-pass-assigned-seats"
            className="font-num font-black text-[26px] text-sg-ink tracking-tight"
          >
            {seatText}
          </div>
        </div>

        <div className="grid gap-2 text-[13.5px]">
          <div className="flex items-baseline gap-2">
            <span className="text-sg-muted">今天可使用到</span>
            <span className="font-num font-bold text-[18px] text-sg-ink">
              {entryData.until || '21:00'}
            </span>
          </div>
          <div className="text-[12.5px] text-sg-muted leading-relaxed">
            <b>進出：</b>期間憑條碼或電話可自由進出
          </div>
          <div className="text-[12.5px] text-sg-muted leading-relaxed">
            <b>熨燙：</b>{entryData.iron_text || '店員會在今天下午到店協助熨燙'}。完成後請放在熨燙區的托盤上
          </div>
          {Array.isArray(entryData.boards) && entryData.boards.length > 0 && (
            <div className="text-[12.5px] text-sg-muted">
              <b>智能板：</b>
              <span className="font-bold text-sg-ink">
                {entryData.boards.map((b) => `${b.name} ×${b.quantity}`).join('、')}
              </span>
            </div>
          )}
        </div>

        {showQr && (
          <div className="pt-3 border-t border-sg-sage/40 grid gap-3 text-center justify-items-center">
            <div className="text-[14px] font-bold text-sg-ink">再次進門的條碼</div>
            <div className="p-2.5 bg-white rounded-[14px] border border-sg-line flex flex-col items-center">
              <canvas
                ref={canvasRef}
                data-testid="reentry-pass-qr-canvas"
                style={{ width: 200, height: 200 }}
              />
            </div>
            <div className="text-[12px] font-num text-sg-muted">
              <span className="font-bold text-sg-brown">{formatCountdown(countdownSec)}</span> 後自動更新
            </div>
            <div className="text-[12px] text-sg-muted">
              在報到機也可以用電話報到：{phoneDisplay}
            </div>
          </div>
        )}

        <Button
          variant="secondary"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            setShowQr(!showQr);
          }}
          className="w-full mt-1 font-bold"
        >
          {showQr ? '收起條碼' : '要再進門？顯示進場條碼'}
        </Button>

        {/* 第 27 輪座位地圖預留位置 */}
        <div className="text-center text-[11px] text-sg-muted/70">
          {/* 座位地圖（第 27 輪） */}
        </div>
      </div>
    );
  }

  if (entryData.state === 'ended') {
    return (
      <div
        data-testid={`entry-pass-ended-${bookingRef}`}
        className="rounded-[16px] border border-sg-line bg-sg-bg p-4 text-center text-sg-muted text-[14px]"
      >
        今天的使用時間已結束
      </div>
    );
  }

  // 尚未付款或未付清狀態回退
  return null;
}
