import React, { useState, useEffect, useMemo } from 'react';
import { User, Phone, Users, Clock, Sparkles } from 'lucide-react';
import api from '../api/axios';
import ResponsivePanel from './admin/ResponsivePanel';
import Button from './customer/Button';
import { isSessionPast } from '../utils/admin/floorSelectors';

export default function ForceAddModal({
  isOpen,
  onClose,
  selectedSessionId,
  sessions = [],
  onSuccess
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [pax, setPax] = useState(1);
  const [isUnlimited, setIsUnlimited] = useState(false);
  const [isForceWait, setIsForceWait] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Sort sessions chronologically
  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
  }, [sessions]);

  // Default selection starting from "now"
  useEffect(() => {
    if (!isOpen) return;
    setError('');
    setIsSubmitting(false);

    if (selectedSessionId) {
      setSelectedSessionIds([selectedSessionId]);
      return;
    }

    if (sortedSessions.length > 0) {
      const foundIdx = sortedSessions.findIndex(s => !isSessionPast(s));
      const startIdx = foundIdx >= 0 ? foundIdx : -1;
      if (startIdx >= 0) {
        const endIdx = Math.min(sortedSessions.length - 1, startIdx + 1);
        const validRange = sortedSessions.slice(startIdx, endIdx + 1).filter(s => !isSessionPast(s));
        setSelectedSessionIds(validRange.map(s => s.id));
      } else {
        setSelectedSessionIds([]);
      }
    } else {
      setSelectedSessionIds([]);
    }
  }, [isOpen, selectedSessionId, sortedSessions]);

  if (!isOpen) return null;

  const handleToggleSession = (sId) => {
    const sIndex = sortedSessions.findIndex(s => s.id === sId);
    if (sIndex < 0 || isSessionPast(sortedSessions[sIndex])) return;

    if (selectedSessionIds.length === 0) {
      setSelectedSessionIds([sId]);
      return;
    }

    const currentIndices = selectedSessionIds
      .map(id => sortedSessions.findIndex(s => s.id === id))
      .filter(i => i >= 0)
      .sort((a, b) => a - b);

    const minIdx = currentIndices[0];
    const maxIdx = currentIndices[currentIndices.length - 1];

    if (sIndex < minIdx) {
      // Extend range left
      setSelectedSessionIds(sortedSessions.slice(sIndex, maxIdx + 1).map(s => s.id));
    } else if (sIndex > maxIdx) {
      // Extend range right
      setSelectedSessionIds(sortedSessions.slice(minIdx, sIndex + 1).map(s => s.id));
    } else {
      // Clicked inside or boundary: reset to just this slot
      setSelectedSessionIds([sId]);
    }
  };

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    const cleanName = name.trim();
    const paxNum = parseInt(pax, 10);

    if (!cleanName) {
      setError('請輸入顧客姓名');
      return;
    }
    if (!paxNum || paxNum < 1) {
      setError('人數必須至少 1 位');
      return;
    }
    if (selectedSessionIds.length === 0) {
      setError('請至少選擇一個時段');
      return;
    }

    try {
      setIsSubmitting(true);
      setError('');

      // Chronologically sorted session IDs
      const sortedIds = [...selectedSessionIds].sort((a, b) => {
        const sA = sortedSessions.find(s => s.id === a);
        const sB = sortedSessions.find(s => s.id === b);
        return (sA?.start_time || '').localeCompare(sB?.start_time || '');
      });

      const res = await api.post('/reservations/admin', {
        name: cleanName,
        phone: phone.trim() || null,
        pax: paxNum,
        session_ids: sortedIds,
        isUnlimited,
        isForceWait,
        forceSplit: true,
        isWalkIn: true,
        attendance: isForceWait ? null : 'checked_in',
        autoCheckIn: !isForceWait,
        equipments: []
      });

      const bookingRef = res.data?.reservation?.booking_ref;
      const assignedSeats = res.data?.reservation?.assigned_seats || [];

      const bookedSessions = sortedSessions.filter(s => sortedIds.includes(s.id));
      const startTime = bookedSessions[0]?.start_time || '';
      const endTime = bookedSessions[bookedSessions.length - 1]?.end_time || '';

      const createdBooking = {
        booking_ref: bookingRef,
        name: cleanName,
        phone: phone.trim() || null,
        pax: paxNum,
        assigned_seats: assignedSeats,
        reason: res.data?.reservation?.reason,
        start_time: startTime,
        end_time: endTime,
        sessions: bookedSessions,
        is_unlimited: isUnlimited,
        isForceWait
      };

      onClose();
      if (onSuccess) {
        onSuccess(isForceWait ? null : createdBooking, isForceWait);
      }

      // Reset
      setName('');
      setPhone('');
      setPax(1);
      setIsUnlimited(false);
      setIsForceWait(false);
    } catch (err) {
      console.error('Failed to create walk-in reservation:', err);
      setError(err.response?.data?.error || '建立失敗，請稍後再試');
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedSessionsList = sortedSessions.filter(s => selectedSessionIds.includes(s.id));
  const timeSummary = selectedSessionsList.length > 0
    ? `${selectedSessionsList[0].start_time} 到 ${selectedSessionsList[selectedSessionsList.length - 1].end_time}（${selectedSessionsList.length} 小時）`
    : '尚未選取時段';

  return (
    <ResponsivePanel
      isOpen={isOpen}
      onClose={onClose}
      title="現場加人"
      subtitle={isForceWait ? '加入等待區' : '建立後直接帶位'}
      footer={
        <div className="space-y-2">
          {error && (
            <div className="p-2.5 rounded-xl bg-sg-danger-soft text-sg-danger text-[12px] font-bold">
              {error}
            </div>
          )}
          <div className="flex items-center justify-between">
            <Button
              variant="secondary"
              size="sm"
              onClick={onClose}
              disabled={isSubmitting}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={handleSubmit}
              loading={isSubmitting}
            >
              {isForceWait ? '放入等待區' : '下一步：安排座位'}
            </Button>
          </div>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4 py-2">
        {/* Name and Phone */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[12px] font-bold text-sg-ink mb-1">
              顧客姓名 <span className="text-sg-danger">*</span>
            </label>
            <div className="relative">
              <User className="w-4 h-4 text-sg-muted absolute left-3 top-2.5" />
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：王先生"
                className="w-full pl-9 pr-3 py-2 rounded-xl border border-sg-line text-[13px] text-sg-ink focus:outline-none focus:border-sg-brown"
              />
            </div>
          </div>

          <div>
            <label className="block text-[12px] font-bold text-sg-ink mb-1">
              電話 <span className="text-sg-muted text-[11px] font-normal">（選填）</span>
            </label>
            <div className="relative">
              <Phone className="w-4 h-4 text-sg-muted absolute left-3 top-2.5" />
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0912345678"
                className="w-full pl-9 pr-3 py-2 rounded-xl border border-sg-line text-[13px] text-sg-ink focus:outline-none focus:border-sg-brown"
              />
            </div>
          </div>
        </div>

        {/* Pax */}
        <div>
          <label className="block text-[12px] font-bold text-sg-ink mb-1">
            人數
          </label>
          <div className="flex items-center gap-3">
            <div className="flex items-center border border-sg-line rounded-xl overflow-hidden bg-white">
              <button
                type="button"
                onClick={() => setPax(prev => Math.max(1, prev - 1))}
                className="px-3.5 py-2 text-[14px] font-bold text-sg-ink hover:bg-sg-paper active:bg-sg-line transition"
              >
                −
              </button>
              <span className="w-12 text-center text-[14px] font-bold font-num text-sg-ink">
                {pax}
              </span>
              <button
                type="button"
                onClick={() => setPax(prev => prev + 1)}
                className="px-3.5 py-2 text-[14px] font-bold text-sg-ink hover:bg-sg-paper active:bg-sg-line transition"
              >
                +
              </button>
            </div>
            <span className="text-[12px] text-sg-muted">位顧客</span>
          </div>
        </div>

        {/* Sessions Continuous Selection */}
        <div className="space-y-1.5 pt-2 border-t border-sg-line">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-bold text-sg-ink">時段選擇</span>
            <span className="text-[11px] text-sg-muted font-num">{timeSummary}</span>
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5 max-h-48 overflow-y-auto p-1 bg-sg-paper/40 rounded-2xl border border-sg-line">
            {sortedSessions.map((s) => {
              const isPast = isSessionPast(s);
              const isSelected = selectedSessionIds.includes(s.id);
              const remaining = s.remaining_capacity ?? s.max_capacity ?? 0;
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={isPast}
                  onClick={() => !isPast && handleToggleSession(s.id)}
                  className={`p-2 rounded-xl border text-center transition ${
                    isPast
                      ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed opacity-60'
                      : isSelected
                      ? 'bg-sg-brown text-white border-sg-brown font-bold shadow-xs'
                      : 'bg-white text-sg-ink border-sg-line hover:border-sg-brown'
                  }`}
                >
                  <span className="block text-[12px] font-num">{s.start_time}</span>
                  <span className="block text-[10px] opacity-75">
                    {isPast ? '已過' : `餘 ${remaining}`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Toggles */}
        <div className="space-y-3 pt-2 border-t border-sg-line">
          {/* Unlimited play */}
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[13px] font-bold text-sg-ink block">是否當日不限時</span>
              <span className="text-[11px] text-sg-muted block">依全日不限時費率計價</span>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={isUnlimited}
                onChange={(e) => setIsUnlimited(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-sg-line peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-sg-line after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-sg-brown"></div>
            </label>
          </div>

          {/* Wait area toggle */}
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[13px] font-bold text-sg-ink block">先放入等待區</span>
              <span className="text-[11px] text-sg-muted block">預設直接安排座位帶位；如現場爆滿可改放入等候區</span>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={isForceWait}
                onChange={(e) => setIsForceWait(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-sg-line peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-sg-line after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-sg-brown"></div>
            </label>
          </div>
        </div>
      </form>
    </ResponsivePanel>
  );
}
