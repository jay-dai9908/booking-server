import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRightLeft,
  RotateCcw,
  Plus,
  Clock,
  FileText,
  MoreHorizontal,
  LogOut,
  CreditCard,
  RefreshCw,
  UserCheck
} from 'lucide-react';
import ResponsivePanel from '../ResponsivePanel';
import Button from '../../customer/Button';
import { displayBoardName } from '../../../../../shared/billing.js';
import { getPersonStatusText } from '../../../utils/admin/floorSelectors.js';

function formatTimeHHMM(val) {
  if (!val) return '';
  if (typeof val === 'string' && val.length === 5 && val.includes(':')) return val;
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' });
  } catch {
    return '';
  }
}

export default function SeatActionPanel({
  isOpen = false,
  onClose,
  target = null,
  onCheckout,
  onDetails,
  onTimerAction,
  onMoveSeat,
  onMoveToWait,
  onBoardSwap,
  onAddBoard,
  onExtendTime,
  onForceAdd,
  onCheckIn,
  onLeave,
  onSupplement,
  onRefund
}) {
  const [showMoreMenu, setShowMoreMenu] = useState(false);

  if (!target) return null;

  const seat = target.seat;
  const booking = target.booking || target.seatInfo?.booking;
  const seatInfo = target.seatInfo || {};
  const isInactive = seat && seat.is_active === false;
  const personNo = seatInfo.personNo || 1;

  // Determine seat status / mode
  let mode = 'empty';
  const isPending = !booking || !booking.attendance || booking.attendance === 'pending';
  if (isInactive) {
    mode = 'inactive';
  } else if (!booking) {
    mode = 'empty';
  } else if (isPending) {
    mode = 'reserved'; // 待入座
  } else if (booking.billing?.status === 'paid' || booking.is_paid || seatInfo.isPaid) {
    mode = 'paid';
  } else if (seatInfo.state === 'paused') {
    mode = 'paused';
  } else {
    mode = 'in_use';
  }

  // Header Title
  let title = '座位操作';
  if (mode === 'inactive' || mode === 'empty') {
    title = seat?.code ? `座位 ${seat.code}` : '座位操作';
  } else if (booking) {
    title = seat?.code ? `${seat.code} ${booking.name || ''}`.trim() : (booking.name || '現場客人');
  }

  // Header Subtitle
  let subtitle = '';
  if (mode === 'inactive') {
    subtitle = '這個座位已暫停使用';
  } else if (mode === 'empty') {
    subtitle = '空位';
  } else if (mode === 'reserved') {
    const startStr = booking.start_at ? formatTimeHHMM(booking.start_at) : (booking.start_time || '');
    const pax = booking.pax || 1;
    subtitle = `${startStr} 到 · 預定 ${pax} 位`;
  } else if (mode === 'paid') {
    const personPart = `第 ${personNo} 位`;
    const personBoard = (booking.boards || []).find(bd => bd.person_no === personNo) || (booking.boards || [])[0];
    let boardPart = '';
    if (personBoard?.segments?.length) {
      const curSeg = personBoard.segments.find(s => !s.end_at) || personBoard.segments[personBoard.segments.length - 1];
      const bName = displayBoardName(curSeg?.name || '小板');
      const bStart = curSeg?.start_at ? formatTimeHHMM(curSeg.start_at) : (booking.start_at ? formatTimeHHMM(booking.start_at) : '');
      boardPart = bStart ? `${bName} ${bStart} 起` : bName;
    }

    const endStr = booking.end_at ? formatTimeHHMM(booking.end_at) : (booking.end_time || '');
    const endPart = endStr ? `預約到 ${endStr}` : '';

    const payment = (booking?.payments || []).slice().reverse().find(pay =>
      !pay.person_nos || pay.person_nos.length === 0 || pay.person_nos.includes(personNo)
    );
    const methodMap = {
      cash: '現金',
      line_pay: 'LINE Pay',
      card: '信用卡',
      credit_card: '信用卡',
      jkopay: '街口',
      transfer: '轉帳',
      pass: '票券',
      waive: '免收',
      none: '免收'
    };
    const methodStr = (payment && (methodMap[payment.method] || payment.method)) || '現金';
    const payTime = payment?.created_at ? formatTimeHHMM(payment.created_at) : '';
    const paidDetail = payTime ? `已付 · ${methodStr} ${payTime}` : (payment ? `已付 · ${methodStr}` : '已付');

    subtitle = [personPart, boardPart, endPart, paidDetail].filter(Boolean).join(' · ');
  } else {
    // 計時中 or 暫停
    const personPart = `第 ${personNo} 位`;
    let statusPart = '';
    const rawTimer = (seatInfo.timerText || '').replace(/^(計時中|已暫停|暫停)\s*/, '').trim();
    if (mode === 'paused') {
      statusPart = rawTimer ? `已暫停 ${rawTimer}` : '已暫停';
    } else {
      statusPart = rawTimer ? `計時中 ${rawTimer}` : '計時中';
    }

    const personBoard = (booking.boards || []).find(bd => bd.person_no === personNo) || (booking.boards || [])[0];
    let boardPart = '';
    if (personBoard?.segments?.length) {
      const curSeg = personBoard.segments.find(s => !s.end_at) || personBoard.segments[personBoard.segments.length - 1];
      const bName = displayBoardName(curSeg?.name || '小板');
      const bStart = curSeg?.start_at ? formatTimeHHMM(curSeg.start_at) : (booking.start_at ? formatTimeHHMM(booking.start_at) : '');
      boardPart = bStart ? `${bName} ${bStart} 起` : bName;
    }

    const endStr = booking.end_at ? formatTimeHHMM(booking.end_at) : (booking.end_time || '');
    const endPart = endStr ? `預約到 ${endStr}` : '';

    subtitle = [personPart, statusPart, boardPart, endPart].filter(Boolean).join(' · ');
  }

  // Group members (同組)
  const allPersons = booking?.persons || [];
  const otherPersons = allPersons.filter(p => p.person_no !== personNo);

  // Board for this person
  const currentBoard = (booking?.boards || []).find(bd => bd.person_no === personNo) || (booking?.boards || [])[0];

  const headerRight = (mode === 'in_use' || mode === 'paused' || mode === 'reserved') ? (
    <div className="relative">
      <button
        type="button"
        data-testid="seat-panel-more-btn"
        onClick={() => setShowMoreMenu(prev => !prev)}
        className="w-9 h-9 flex items-center justify-center rounded-full text-sg-muted hover:text-sg-ink hover:bg-sg-paper transition"
        title="更多選項"
      >
        <MoreHorizontal className="w-5 h-5" />
      </button>

      {showMoreMenu && (
        <div
          data-testid="seat-panel-more-menu"
          className="absolute right-0 top-full mt-1 z-50 bg-white rounded-2xl shadow-xl border border-sg-line py-1 min-w-[140px] space-y-0.5"
          onClick={() => setShowMoreMenu(false)}
        >
          <button
            type="button"
            data-testid="seat-panel-move-wait-btn"
            onClick={() => {
              if (onMoveToWait && booking && seat) {
                onMoveToWait(booking, seat.code);
              }
            }}
            className="w-full text-left px-3 py-2 text-[12px] font-bold text-sg-ink hover:bg-sg-paper flex items-center gap-2 cursor-pointer"
          >
            <ArrowRightLeft className="w-3.5 h-3.5 text-sg-muted" />
            移到等待區
          </button>
        </div>
      )}
    </div>
  ) : null;

  return (
    <ResponsivePanel
      isOpen={isOpen}
      onClose={() => {
        setShowMoreMenu(false);
        onClose();
      }}
      title={title}
      subtitle={subtitle}
      width={380}
      headerRight={headerRight}
      footer={
        mode === 'reserved' ? (
          <div className="w-full">
            <Button
              variant="primary"
              size="lg"
              className="w-full font-bold"
              data-testid="seat-panel-checkin-btn"
              onClick={() => {
                if (onCheckIn && booking) onCheckIn(booking);
              }}
            >
              報到並帶位
            </Button>
          </div>
        ) : mode === 'in_use' || mode === 'paused' ? (
          <div className="w-full">
            <Button
              variant="primary"
              size="lg"
              className="w-full font-bold"
              data-testid="seat-panel-checkout-btn"
              onClick={() => {
                if (onCheckout && booking) onCheckout(booking.booking_ref);
              }}
            >
              結帳
            </Button>
          </div>
        ) : mode === 'empty' ? (
          <div className="w-full">
            <Button
              variant="primary"
              size="lg"
              className="w-full font-bold"
              data-testid="seat-panel-force-add-btn"
              onClick={() => {
                if (onForceAdd && seat) onForceAdd(seat.code);
              }}
            >
              現場加人（坐這裡）
            </Button>
          </div>
        ) : null
      }
    >
      <div className="space-y-4 py-1" data-testid="seat-action-panel-content">
        {mode === 'inactive' && (
          <div className="py-6 text-center space-y-3">
            <p className="text-[13px] text-sg-muted">這個座位已暫停使用</p>
            <Link
              to="/admin/seat-layout"
              onClick={onClose}
              className="text-sg-brown underline font-bold text-[13px] hover:text-sg-brown/80 inline-block"
            >
              到座位設定
            </Link>
          </div>
        )}

        {mode === 'empty' && (
          <div className="py-6 text-center text-sg-muted text-[13px]">
            此座位目前為空位，可直接安排現場客人入座。
          </div>
        )}

        {mode === 'reserved' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-[12px]">
              <Button
                variant="secondary"
                size="sm"
                data-testid="seat-panel-move-btn"
                onClick={() => {
                  if (onMoveSeat && booking && seat) {
                    onMoveSeat({
                      booking,
                      fromSeat: seat.code,
                      personNo: 1
                    });
                  }
                }}
              >
                <ArrowRightLeft className="w-3.5 h-3.5 mr-1" />
                換座位
              </Button>

              <Button
                variant="secondary"
                size="sm"
                data-testid="seat-panel-details-btn"
                onClick={() => {
                  if (onDetails && booking) onDetails(booking.booking_ref);
                }}
              >
                <FileText className="w-3.5 h-3.5 mr-1" />
                訂單詳情
              </Button>
            </div>
          </div>
        )}

        {(mode === 'in_use' || mode === 'paused') && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 text-[12px]">
              <Button
                variant="secondary"
                size="sm"
                data-testid="seat-panel-timer-toggle-btn"
                onClick={() => {
                  if (onTimerAction && booking) {
                    onTimerAction(booking.booking_ref, [personNo], mode === 'paused' ? 'resume' : 'pause');
                  }
                }}
              >
                {mode === 'paused' ? '繼續計時' : '暫停計時'}
              </Button>

              {currentBoard ? (
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="seat-panel-swap-board-btn"
                  onClick={() => {
                    if (onBoardSwap && booking && seat) {
                      onBoardSwap({
                        booking,
                        board: currentBoard,
                        personNo,
                        seatCode: seat.code
                      });
                    }
                  }}
                >
                  <RotateCcw className="w-3.5 h-3.5 mr-1" />
                  換板
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="seat-panel-add-board-btn"
                  onClick={() => {
                    if (onAddBoard && booking) onAddBoard(booking);
                  }}
                >
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  加租智能板
                </Button>
              )}

              <Button
                variant="secondary"
                size="sm"
                data-testid="seat-panel-move-btn"
                onClick={() => {
                  if (onMoveSeat && booking && seat) {
                    onMoveSeat({
                      booking,
                      fromSeat: seat.code,
                      personNo
                    });
                  }
                }}
              >
                <ArrowRightLeft className="w-3.5 h-3.5 mr-1" />
                換座位
              </Button>

              <Button
                variant="secondary"
                size="sm"
                data-testid="seat-panel-extend-btn"
                onClick={() => {
                  if (onExtendTime && booking) onExtendTime(booking);
                }}
              >
                <Clock className="w-3.5 h-3.5 mr-1" />
                加時
              </Button>

              <Button
                variant="secondary"
                size="sm"
                data-testid="seat-panel-details-btn"
                onClick={() => {
                  if (onDetails && booking) onDetails(booking.booking_ref);
                }}
              >
                <FileText className="w-3.5 h-3.5 mr-1" />
                訂單詳情
              </Button>
            </div>

            {/* 同組清單 (Spec 6.6) */}
            {otherPersons.length > 0 && (
              <div className="space-y-2 pt-2 border-t border-sg-line">
                <div className="text-[12px] font-bold text-sg-ink">同組</div>
                <div className="space-y-1.5">
                  {otherPersons.map(p => {
                    const isPaused = Boolean(p.timer?.paused_at && !p.timer?.timer_ended_at);
                    const pStatusText = getPersonStatusText(p, booking);
                    const pReason = p.timer?.pause_reason;
                    const seatCodeStr = p.seat_code || (booking?.assigned_seats && booking.assigned_seats[p.person_no - 1]) || '未排座';

                    return (
                      <div
                        key={p.person_no}
                        className="flex items-center justify-between p-2 rounded-xl bg-sg-paper/50 border border-sg-line text-[12px]"
                      >
                        <span className="font-medium text-sg-ink truncate">
                          {seatCodeStr} 第 {p.person_no} 位 {pStatusText}
                          {pReason ? ` · ${pReason}` : ''}
                        </span>
                        {!p.timer?.timer_ended_at && (
                          <button
                            type="button"
                            onClick={() => {
                              if (onTimerAction && booking) {
                                onTimerAction(booking.booking_ref, [p.person_no], isPaused ? 'resume' : 'pause');
                              }
                            }}
                            className="px-2.5 py-1 rounded-lg text-[11px] font-bold border border-sg-line bg-white hover:bg-sg-paper text-sg-brown transition"
                          >
                            {isPaused ? '繼續' : '暫停'}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <p className="text-[11px] text-sg-muted text-center pt-2">
              也可以長按座位，直接拖到其他空位。
            </p>
          </div>
        )}

        {mode === 'paid' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 text-[12px]">
              <Button
                variant="secondary"
                size="sm"
                data-testid="seat-panel-leave-btn"
                onClick={() => {
                  if (onLeave && booking) onLeave(booking.booking_ref, personNo);
                }}
              >
                <LogOut className="w-3.5 h-3.5 mr-1" />
                離場
              </Button>

              <Button
                variant="secondary"
                size="sm"
                data-testid="seat-panel-supplement-btn"
                onClick={() => {
                  if (onSupplement && booking) onSupplement(booking.booking_ref);
                }}
              >
                <CreditCard className="w-3.5 h-3.5 mr-1" />
                補收
              </Button>

              <Button
                variant="secondary"
                size="sm"
                data-testid="seat-panel-refund-btn"
                onClick={() => {
                  if (onRefund && booking) onRefund(booking.booking_ref);
                }}
              >
                <RefreshCw className="w-3.5 h-3.5 mr-1" />
                退款
              </Button>

              <Button
                variant="secondary"
                size="sm"
                data-testid="seat-panel-details-btn"
                onClick={() => {
                  if (onDetails && booking) onDetails(booking.booking_ref);
                }}
              >
                <FileText className="w-3.5 h-3.5 mr-1" />
                訂單詳情
              </Button>
            </div>

            {/* 同組清單 */}
            {otherPersons.length > 0 && (
              <div className="space-y-2 pt-2 border-t border-sg-line">
                <div className="text-[12px] font-bold text-sg-ink">同組</div>
                <div className="space-y-1.5">
                  {otherPersons.map(p => {
                    const isPaused = Boolean(p.timer?.paused_at && !p.timer?.timer_ended_at);
                    const pStatusText = getPersonStatusText(p, booking);
                    const pReason = p.timer?.pause_reason;
                    const seatCodeStr = p.seat_code || (booking?.assigned_seats && booking.assigned_seats[p.person_no - 1]) || '未排座';

                    return (
                      <div
                        key={p.person_no}
                        className="flex items-center justify-between p-2 rounded-xl bg-sg-paper/50 border border-sg-line text-[12px]"
                      >
                        <span className="font-medium text-sg-ink truncate">
                          {seatCodeStr} 第 {p.person_no} 位 {pStatusText}
                          {pReason ? ` · ${pReason}` : ''}
                        </span>
                        {!p.timer?.timer_ended_at && (
                          <button
                            type="button"
                            onClick={() => {
                              if (onTimerAction && booking) {
                                onTimerAction(booking.booking_ref, [p.person_no], isPaused ? 'resume' : 'pause');
                              }
                            }}
                            className="px-2.5 py-1 rounded-lg text-[11px] font-bold border border-sg-line bg-white hover:bg-sg-paper text-sg-brown transition"
                          >
                            {isPaused ? '繼續' : '暫停'}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </ResponsivePanel>
  );
}
