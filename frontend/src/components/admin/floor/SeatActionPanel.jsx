import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRightLeft,
  RotateCcw,
  Plus,
  FileText,
  MoreHorizontal,
  LogOut,
  CreditCard,
  RefreshCw,
  UserCheck,
  Pause,
  Play,
  Move,
  Receipt
} from 'lucide-react';
import ResponsivePanel from '../ResponsivePanel';
import Button from '../../customer/Button';
import { displayBoardName } from '../../../../../shared/billing.js';
import { getPersonStatusText, getPersonTimerElapsedForRemove } from '../../../utils/admin/floorSelectors.js';
import PersonTimeline from './PersonTimeline';
import RemovePersonConfirmDialog from './RemovePersonConfirmDialog';

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

function shortBoardSize(name) {
  const clean = displayBoardName(name || '');
  if (clean.includes('小板')) return '小板';
  if (clean.includes('中板')) return '中板';
  if (clean.includes('大板')) return '大板';
  return clean.split(/[\s(（]/)[0] || '智能板';
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
  onBoardPauseToggle,
  onBoardReturn,
  onAddBoard,
  onExtendTime,
  onForceAdd,
  onCheckIn,
  onLeave,
  onRemovePerson,
  onSupplement,
  onRefund,
  serverNow = null
}) {
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [confirmReturnBoard, setConfirmReturnBoard] = useState(false);
  const [showRemoveDialog, setShowRemoveDialog] = useState(false);

  const resetSeatKey = target?.seat?.code || '';
  const resetBookingRef = target?.booking?.booking_ref || target?.seatInfo?.booking?.booking_ref || '';
  useEffect(() => {
    setConfirmReturnBoard(false);
    setShowRemoveDialog(false);
  }, [isOpen, resetSeatKey, resetBookingRef]);

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
  const currentPerson = allPersons.find(p => Number(p.person_no) === Number(personNo)) || null;
  const otherPersons = allPersons.filter(p => p.person_no !== personNo);

  // Board for this person
  const currentBoard = (booking?.boards || []).find(bd => bd.person_no === personNo) || (booking?.boards || [])[0];
  const personBoard =
    (booking?.boards || []).find(bd => Number(bd.person_no) === Number(personNo)) ||
    (allPersons.length <= 1 ? (booking?.boards || [])[0] : null);
  const activeBoardSegment = personBoard?.segments?.find(s => !s.end_at) || null;
  const activeBoardPause = (personBoard?.pauses || []).find(bp => !bp.ended_at) || null;

  const boardQuickControls = activeBoardSegment && personBoard?.unit_group ? (
    <>
      <button
        type="button"
        data-testid="seat-panel-board-pause-btn"
        onClick={() => {
          if (onBoardPauseToggle && booking) {
            onBoardPauseToggle(booking.booking_ref, personBoard.unit_group, Boolean(activeBoardPause));
          }
        }}
        className={`rounded-full px-3.5 py-1.5 text-[12px] font-bold border transition cursor-pointer whitespace-nowrap ${
          activeBoardPause
            ? 'bg-sg-brown text-white border-sg-brown hover:bg-sg-brown/90 shadow-2xs'
            : 'bg-white text-sg-ink border-sg-line hover:bg-sg-bg'
        }`}
      >
        {activeBoardPause ? '繼續使用智能板' : '智能板單獨暫停'}
      </button>
      <button
        type="button"
        data-testid="seat-panel-board-return-btn"
        onClick={() => {
          if (!confirmReturnBoard) {
            setConfirmReturnBoard(true);
            return;
          }
          setConfirmReturnBoard(false);
          if (onBoardReturn && booking) {
            onBoardReturn(booking.booking_ref, personBoard.unit_group);
          }
        }}
        className={`rounded-full px-3.5 py-1.5 text-[12px] font-bold border transition cursor-pointer whitespace-nowrap ${
          confirmReturnBoard
            ? 'bg-sg-danger text-white border-sg-danger hover:bg-sg-danger/90 shadow-2xs'
            : 'bg-white text-sg-danger border-sg-line hover:bg-sg-danger-soft/40'
        }`}
      >
        {confirmReturnBoard
          ? `確定歸還${shortBoardSize(activeBoardSegment.name)}？再按一次`
          : '不用了，歸還'}
      </button>
    </>
  ) : null;

  const actionTileClass =
    'rounded-2xl border border-sg-line bg-white hover:bg-sg-paper active:scale-[0.98] text-sg-ink py-3 px-2 flex flex-col items-center justify-center gap-1.5 text-[12px] font-bold transition cursor-pointer shadow-2xs';

  const renderOtherPersonsSection = () => {
    if (otherPersons.length === 0) return null;
    return (
      <div className="space-y-2 pt-2 border-t border-sg-line">
        <div className="space-y-2">
          {otherPersons.map(p => {
            const isPaused = Boolean(p.timer?.paused_at && !p.timer?.timer_ended_at);
            const pStatusText = getPersonStatusText(p, booking);
            const pReason = p.timer?.pause_reason;
            const seatCodeStr = p.seat_code || (booking?.assigned_seats && booking.assigned_seats[p.person_no - 1]) || '未排座';

            return (
              <div
                key={p.person_no}
                className="flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-2xl bg-sg-paper/80 border border-sg-line"
              >
                <span className="px-2 py-1 rounded-lg bg-[#EFE7DE] text-sg-brown font-num text-[11px] font-bold shrink-0">
                  {seatCodeStr}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-bold text-sg-ink leading-tight">
                    同組 · 第 {p.person_no} 位
                  </div>
                  <div className="text-[11px] text-sg-muted truncate mt-0.5">
                    {pStatusText}{pReason ? ` · ${pReason}` : ''}
                  </div>
                </div>
                {!p.timer?.timer_ended_at && (
                  <button
                    type="button"
                    aria-label={isPaused ? `繼續第 ${p.person_no} 位計時` : `暫停第 ${p.person_no} 位計時`}
                    title={isPaused ? '繼續計時' : '暫停計時'}
                    onClick={() => {
                      if (onTimerAction && booking) {
                        onTimerAction(booking.booking_ref, [p.person_no], isPaused ? 'resume' : 'pause');
                      }
                    }}
                    className="w-9 h-9 rounded-full bg-sg-brown hover:bg-sg-brown/90 active:scale-95 text-white flex items-center justify-center shrink-0 shadow-2xs transition cursor-pointer"
                  >
                    {isPaused ? <Play className="w-4 h-4 ml-0.5" /> : <Pause className="w-4 h-4" />}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const removeInfo = getPersonTimerElapsedForRemove(currentPerson, serverNow || new Date());
  const canShowRemove = (mode === 'in_use' || mode === 'paused') && removeInfo.canShow;

  const headerRight = (mode === 'in_use' || mode === 'paused' || mode === 'reserved') ? (
    <div className="flex items-center gap-1.5">
      {canShowRemove && (
        <button
          type="button"
          data-testid="seat-panel-remove-person-btn"
          onClick={() => setShowRemoveDialog(true)}
          className="px-2 py-1 rounded-lg text-[11px] font-bold text-sg-danger bg-sg-danger-soft/80 hover:bg-sg-danger-soft border border-sg-danger/25 transition whitespace-nowrap cursor-pointer"
        >
          這位不玩了
        </button>
      )}
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
            <PersonTimeline
              booking={booking}
              person={currentPerson}
              personNo={personNo}
              now={serverNow}
            >
              {boardQuickControls}
            </PersonTimeline>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                data-testid="seat-panel-timer-toggle-btn"
                className={actionTileClass}
                onClick={() => {
                  if (onTimerAction && booking) {
                    onTimerAction(booking.booking_ref, [personNo], mode === 'paused' ? 'resume' : 'pause');
                  }
                }}
              >
                {mode === 'paused' ? <Play className="w-4 h-4 text-sg-brown" /> : <Pause className="w-4 h-4 text-sg-brown" />}
                <span>{mode === 'paused' ? '繼續計時' : '暫停計時'}</span>
              </button>

              {currentBoard ? (
                <button
                  type="button"
                  data-testid="seat-panel-swap-board-btn"
                  className={actionTileClass}
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
                  <RotateCcw className="w-4 h-4 text-sg-brown" />
                  <span>換板</span>
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="seat-panel-add-board-btn"
                  className={actionTileClass}
                  onClick={() => {
                    if (onAddBoard && booking) onAddBoard(booking);
                  }}
                >
                  <Plus className="w-4 h-4 text-sg-brown" />
                  <span>加租智能板</span>
                </button>
              )}

              <button
                type="button"
                data-testid="seat-panel-move-btn"
                className={actionTileClass}
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
                <Move className="w-4 h-4 text-sg-brown" />
                <span>換座位</span>
              </button>

              <button
                type="button"
                data-testid="seat-panel-extend-btn"
                className={actionTileClass}
                onClick={() => {
                  if (onExtendTime && booking) onExtendTime(booking);
                }}
              >
                <Plus className="w-4 h-4 text-sg-brown" />
                <span>加時</span>
              </button>

              <button
                type="button"
                data-testid="seat-panel-details-btn"
                className={actionTileClass}
                onClick={() => {
                  if (onDetails && booking) onDetails(booking.booking_ref);
                }}
              >
                <FileText className="w-4 h-4 text-sg-brown" />
                <span>訂單詳情</span>
              </button>

              <button
                type="button"
                data-testid="seat-panel-checkout-btn"
                onClick={() => {
                  if (onCheckout && booking) onCheckout(booking.booking_ref);
                }}
                className="rounded-2xl border border-sg-brown bg-sg-brown hover:bg-sg-brown/90 active:scale-[0.98] text-white py-3 px-2 flex flex-col items-center justify-center gap-1.5 text-[12px] font-bold transition cursor-pointer shadow-xs"
              >
                <Receipt className="w-4 h-4" />
                <span>結帳</span>
              </button>
            </div>

            {/* 同組清單 (Spec 6.6) */}
            {renderOtherPersonsSection()}

            <p className="text-[11px] text-sg-muted text-center pt-2">
              也可以長按座位，直接拖到其他空位。
            </p>
          </div>
        )}

        {mode === 'paid' && (
          <div className="space-y-4">
            <PersonTimeline
              booking={booking}
              person={currentPerson}
              personNo={personNo}
              now={serverNow}
            >
              {boardQuickControls}
            </PersonTimeline>
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
            {renderOtherPersonsSection()}
          </div>
        )}
      </div>
      <RemovePersonConfirmDialog
        isOpen={showRemoveDialog}
        onClose={() => setShowRemoveDialog(false)}
        elapsedMinutes={removeInfo.elapsedMinutes}
        hasBoard={Boolean(activeBoardSegment)}
        onConfirmRemove={() => {
          if (onRemovePerson && booking) {
            return onRemovePerson(booking.booking_ref, personNo);
          }
          return undefined;
        }}
        onSwitchToLeave={() => {
          if (onLeave && booking) {
            onLeave(booking.booking_ref, personNo);
          }
        }}
      />
    </ResponsivePanel>
  );
}
