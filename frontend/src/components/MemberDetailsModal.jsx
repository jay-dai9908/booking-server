import React, { useState, useEffect } from 'react';
import { format } from 'date-fns';
import {
  UserCog,
  X,
  Pencil,
  Check,
  Sparkles,
  Clock,
  Smartphone,
  Calendar,
  Globe,
  Monitor,
  User,
  MessageCircle,
  Ticket,
  Plus,
  Copy,
  CheckCircle2,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import api from '../api/axios';
import ReservationDetailsModal, { getReservationStatusUI } from './ReservationDetailsModal';
import SendLineMessageModal from './SendLineMessageModal';

export default function MemberDetailsModal({ member, onClose, onMemberUpdated }) {
  const [memberReservations, setMemberReservations] = useState([]);
  const [loginLogs, setLoginLogs] = useState([]);
  const [isMemberLoading, setIsMemberLoading] = useState(false);
  const [isLogsLoading, setIsLogsLoading] = useState(false);
  const [isSavingNotes, setIsSavingNotes] = useState(false);
  const [selectedReservation, setSelectedReservation] = useState(null);
  const [activeTab, setActiveTab] = useState('reservations'); // 'reservations' | 'login_logs' | 'passes'

  // Pass Management State
  const [userPasses, setUserPasses] = useState([]);
  const [isPassesLoading, setIsPassesLoading] = useState(false);
  const [plansList, setPlansList] = useState([]);
  const [showGrantModal, setShowGrantModal] = useState(false);
  const [grantForm, setGrantForm] = useState({
    plan_id: '',
    custom_quota: '',
    valid_days: '90',
    day_restriction: 'ALL',
    max_hours_per_day: '',
    max_days_per_week: '',
    note: ''
  });
  const [isGranting, setIsGranting] = useState(false);
  const [redeemingPassId, setRedeemingPassId] = useState(null);
  const [expandedLogPassId, setExpandedLogPassId] = useState(null);
  const [copiedCode, setCopiedCode] = useState(null);

  // Inline editing state for name & phone
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [showLineModal, setShowLineModal] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  // Local copy of member for optimistic & refreshed updates
  const [localMember, setLocalMember] = useState(member);

  useEffect(() => {
    setLocalMember(member);
    setIsEditingProfile(false);
    setActiveTab('reservations');
    if (member) {
      setEditName(member.name || '');
      setEditPhone(member.phone || '');
      refreshMemberDetails(member.id);
      fetchMemberReservations(member.id);
      fetchMemberLoginLogs(member.id);
      fetchUserPasses(member.id);
      fetchPassPlans();
    }
  }, [member?.id]);

  const refreshMemberDetails = async (userId) => {
    const targetId = userId || localMember?.id;
    if (!targetId) return;
    try {
      const res = await api.get(`/users/${targetId}`);
      if (res.data) {
        setLocalMember(res.data);
        if (onMemberUpdated) onMemberUpdated(res.data);
      }
    } catch (err) {
      console.error('Failed to refresh member details:', err);
    }
  };

  const fetchMemberReservations = async (userId) => {
    const targetId = userId || localMember?.id;
    if (!targetId) return;
    setIsMemberLoading(true);
    try {
      const res = await api.get(`/users/${targetId}/reservations`);
      setMemberReservations(res.data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setIsMemberLoading(false);
    }
  };

  const fetchMemberLoginLogs = async (userId) => {
    const targetId = userId || localMember?.id;
    if (!targetId) return;
    setIsLogsLoading(true);
    try {
      const res = await api.get(`/users/${targetId}/login-logs`);
      setLoginLogs(res.data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLogsLoading(false);
    }
  };

  const fetchUserPasses = async (userId) => {
    const targetId = userId || localMember?.id;
    if (!targetId) return;
    setIsPassesLoading(true);
    try {
      const res = await api.get(`/passes/admin/user/${targetId}`);
      setUserPasses(res.data || []);
    } catch (err) {
      console.error('Failed to fetch member passes:', err);
    } finally {
      setIsPassesLoading(false);
    }
  };

  const fetchPassPlans = async () => {
    try {
      const res = await api.get('/passes/plans');
      setPlansList(res.data || []);
      if (res.data?.length > 0) {
        const first = res.data[0];
        setGrantForm(prev => ({
          ...prev,
          plan_id: String(first.id),
          custom_quota: first.total_quota != null ? String(first.total_quota) : '',
          valid_days: first.valid_days != null ? String(first.valid_days) : '90',
          day_restriction: first.day_restriction || 'ALL'
        }));
      }
    } catch (err) {
      console.error('Failed to fetch pass plans:', err);
    }
  };

  const handleGrantPass = async (e) => {
    e.preventDefault();
    if (!localMember?.id) return;
    setIsGranting(true);
    try {
      await api.post('/passes/admin/grant', {
        user_id: localMember.id,
        plan_id: grantForm.plan_id ? parseInt(grantForm.plan_id, 10) : undefined,
        custom_quota: grantForm.custom_quota ? parseInt(grantForm.custom_quota, 10) : null,
        valid_days: grantForm.valid_days ? parseInt(grantForm.valid_days, 10) : null,
        day_restriction: grantForm.day_restriction || 'ALL',
        max_hours_per_day: grantForm.max_hours_per_day ? parseInt(grantForm.max_hours_per_day, 10) : null,
        max_days_per_week: grantForm.max_days_per_week ? parseInt(grantForm.max_days_per_week, 10) : null,
        note: grantForm.note?.trim() || ''
      });
      alert('已成功發放卡券！');
      setShowGrantModal(false);
      fetchUserPasses(localMember.id);
    } catch (err) {
      alert(err.response?.data?.error || '發放失敗');
    } finally {
      setIsGranting(false);
    }
  };

  const handleRedeemPass = async (pass) => {
    if (!window.confirm(`確定要現場核銷此卡券「${pass.plan?.name || pass.pass_code}」1 次嗎？`)) {
      return;
    }
    setRedeemingPassId(pass.id);
    try {
      const res = await api.post('/passes/admin/redeem', {
        user_pass_id: pass.id,
        deduct_amount: 1,
        note: '後台會員詳情手動核銷'
      });
      alert(`核銷成功！${res.data?.remaining_quota !== null ? `剩餘次數：${res.data.remaining_quota} 次` : ''}`);
      fetchUserPasses(localMember.id);
    } catch (err) {
      alert(err.response?.data?.error || '核銷失敗');
    } finally {
      setRedeemingPassId(null);
    }
  };

  const handleCopyCode = (code) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const handleUpdateMember = async (id, data) => {
    setIsSavingNotes(true);
    try {
      const res = await api.put(`/users/${id}`, data);
      setLocalMember(res.data.user);
      if (onMemberUpdated) onMemberUpdated(res.data.user);
    } catch (err) {
      console.error(err);
      alert(err.response?.data?.error || '更新失敗');
    } finally {
      setIsSavingNotes(false);
    }
  };

  const handleSaveProfile = async (e) => {
    if (e) e.preventDefault();
    const trimmedName = editName.trim();
    if (!trimmedName) {
      alert('會員姓名不可為空白');
      return;
    }
    setIsSavingProfile(true);
    try {
      const res = await api.put(`/users/${localMember.id}`, {
        name: trimmedName,
        phone: editPhone.trim()
      });
      setLocalMember(res.data.user);
      if (onMemberUpdated) onMemberUpdated(res.data.user);
      setIsEditingProfile(false);
    } catch (err) {
      alert(err.response?.data?.error || '儲存會員姓名/電話失敗');
    } finally {
      setIsSavingProfile(false);
    }
  };

  if (!member || !localMember) return null;

  const stats = localMember.stats || {
    unlimited_pax_count: 0,
    unlimited_orders_count: 0,
    regular_person_hours: 0,
    regular_pure_hours: 0,
    regular_orders_count: 0,
    completed_visits_count: 0,
    total_spent: 0,
    no_show_count: 0,
    cancelled_count: 0
  };

  const isManualOnly = localMember.line_user_id?.startsWith('manual_');

  const groupedReservations = Object.values(
    memberReservations.reduce((acc, curr) => {
      const ref = curr.booking_ref;
      if (!acc[ref]) {
        acc[ref] = { ...curr, session: { ...curr.session }, session_count: 1, equipments: curr.equipments || [] };
      } else {
        acc[ref].session_count += 1;
        if (!acc[ref].equipments || acc[ref].equipments.length === 0) {
          acc[ref].equipments = curr.equipments || [];
        }
        if (curr.session?.end_time > acc[ref].session?.end_time) acc[ref].session.end_time = curr.session.end_time;
        if (curr.session?.start_time < acc[ref].session?.start_time) acc[ref].session.start_time = curr.session.start_time;
        if (curr.attendance === 'checked_in') acc[ref].attendance = 'checked_in';
        if (curr.is_paid) acc[ref].is_paid = true;
      }
      return acc;
    }, {})
  ).sort(
    (a, b) =>
      new Date(b.session.session_date) - new Date(a.session.session_date) ||
      b.session.start_time.localeCompare(a.session.start_time)
  );

  return (
    <>
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl overflow-hidden relative z-10 animate-in zoom-in-95 duration-200 flex flex-col max-h-[92vh]">
          {/* Header */}
          <div className="px-6 py-4 border-b border-[#E8DEC8] flex items-center justify-between bg-[#FAF7F2] shrink-0">
            <h2 className="text-xl font-bold text-[#3E332B] flex items-center gap-2">
              <UserCog className="w-5 h-5 text-[#8B5B43]" />
              會員詳細檔案與消費統計
            </h2>
            <button
              onClick={onClose}
              className="p-2 text-[#8C8279] hover:text-[#3E332B] rounded-full hover:bg-[#EBE5DF] transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          
          <div className="p-6 overflow-y-auto flex-1 space-y-6">
            {/* Section 1: Member Profile, LINE Info & Blacklist/Notes */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Left 7 Cols: Profile & LINE Info */}
              <div className="lg:col-span-7 bg-white border border-[#E8DEC8] rounded-2xl p-5 shadow-2xs flex flex-col justify-between space-y-4">
                <div className="flex items-start gap-4">
                  {/* LINE Avatar */}
                  {localMember.line_picture_url ? (
                    <img
                      src={localMember.line_picture_url}
                      alt={localMember.name || 'LINE Avatar'}
                      className="w-16 h-16 rounded-full object-cover border-2 border-[#06C755]/30 shadow-xs shrink-0"
                    />
                  ) : (
                    <div className="w-16 h-16 rounded-full bg-[#FAF7F2] text-[#8B5B43] flex items-center justify-center font-bold text-2xl border border-[#E8DEC8] shrink-0">
                      {localMember.name ? localMember.name.slice(0, 1) : <User className="w-8 h-8" />}
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    {!isEditingProfile ? (
                      <div>
                        <div className="flex items-center flex-wrap gap-2">
                          <h3 className="text-xl font-bold text-[#3E332B]">{localMember.name || '未設定姓名'}</h3>
                          <button
                            type="button"
                            onClick={() => {
                              setEditName(localMember.name || '');
                              setEditPhone(localMember.phone || '');
                              setIsEditingProfile(true);
                            }}
                            className="inline-flex items-center gap-1 text-xs font-bold text-[#8B5B43] bg-[#FAF7F2] hover:bg-[#F2ECE4] border border-[#E8DEC8] px-2.5 py-1 rounded-lg transition-colors"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                            編輯姓名/電話
                          </button>
                          {!localMember.line_user_id?.startsWith('manual_') && (
                            <button
                              type="button"
                              onClick={() => setShowLineModal(true)}
                              className="inline-flex items-center gap-1 text-xs font-bold text-white bg-[#06C755] hover:bg-[#05b34c] px-3 py-1 rounded-lg transition-all shadow-xs"
                              title="發送 LINE 官方帳號訊息至顧客手機"
                            >
                              <MessageCircle className="w-3.5 h-3.5 fill-current" />
                              發送 LINE 訊息
                            </button>
                          )}
                        </div>

                        <p className="text-sm font-mono font-semibold text-[#6D5D52] mt-1">
                          📱 電話：{localMember.phone || '未提供'}
                        </p>

                        {/* LINE Profile Badges */}
                        <div className="mt-2.5 flex flex-wrap items-center gap-2">
                          {localMember.line_display_name ? (
                            <span className="inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full bg-[#06C755]/10 text-[#059941] border border-[#06C755]/20">
                              <span className="w-2 h-2 rounded-full bg-[#06C755]" />
                              LINE 暱稱：{localMember.line_display_name}
                            </span>
                          ) : isManualOnly ? (
                            <span className="inline-flex items-center text-xs px-2.5 py-1 rounded-full bg-[#FAF7F2] text-[#8C8279] border border-[#E8DEC8] font-medium">
                              櫃檯手動建檔（尚未綁定 LINE）
                            </span>
                          ) : (
                            <span className="inline-flex items-center text-xs px-2.5 py-1 rounded-full bg-[#FAF7F2] text-[#8C8279] border border-[#E8DEC8]">
                              已綁定 LINE（下次登入將自動同步暱稱與頭像）
                            </span>
                          )}
                        </div>

                        {localMember.line_status_msg && (
                          <p className="text-xs text-[#8C8279] mt-1.5 italic bg-[#FAF7F2] px-3 py-1.5 rounded-lg border border-[#E8DEC8]">
                            💬 LINE 簽名：「{localMember.line_status_msg}」
                          </p>
                        )}
                      </div>
                    ) : (
                      <form onSubmit={handleSaveProfile} className="space-y-3 bg-[#FAF7F2] p-3.5 rounded-xl border border-[#E8DEC8]">
                        <div>
                          <label className="block text-xs font-bold text-[#3E332B] mb-1">顧客姓名 *</label>
                          <input
                            type="text"
                            required
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="w-full px-3 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-sm font-bold text-[#3E332B] focus:border-[#8B5B43] outline-none"
                            placeholder="輸入會員姓名"
                            autoFocus
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-[#3E332B] mb-1">聯絡電話</label>
                          <input
                            type="tel"
                            value={editPhone}
                            onChange={(e) => setEditPhone(e.target.value)}
                            className="w-full px-3 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-sm font-mono text-[#3E332B] focus:border-[#8B5B43] outline-none"
                            placeholder="輸入手機號碼"
                          />
                        </div>
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            type="submit"
                            disabled={isSavingProfile}
                            className="px-3.5 py-1.5 bg-[#8B5B43] hover:bg-[#7A4F3A] text-white text-xs font-bold rounded-lg flex items-center gap-1 transition-colors disabled:opacity-50"
                          >
                            <Check className="w-3.5 h-3.5" />
                            {isSavingProfile ? '儲存中...' : '儲存變更'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsEditingProfile(false)}
                            className="px-3 py-1.5 text-xs text-[#8C8279] hover:text-[#3E332B] font-bold"
                          >
                            取消
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                </div>

                <div className="pt-3 border-t border-gray-100 grid grid-cols-2 gap-3 text-xs text-gray-500">
                  <div>
                    <span className="text-gray-400 block">註冊時間</span>
                    <span className="font-medium text-gray-700">
                      {format(new Date(localMember.created_at), 'yyyy/MM/dd HH:mm')}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-400 block">最後登入/活躍時間</span>
                    <span className="font-medium text-gray-700">
                      {localMember.last_login_at
                        ? format(new Date(localMember.last_login_at), 'yyyy/MM/dd HH:mm')
                        : '尚無紀錄'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Right 5 Cols: Blacklist & Notes */}
              <div className="lg:col-span-5 bg-gray-50 p-4 rounded-2xl border border-gray-200 space-y-3 flex flex-col justify-between">
                <div className="flex items-center justify-between bg-white px-3.5 py-2.5 rounded-xl border border-gray-200">
                  <div>
                    <span className="text-sm font-bold text-gray-800 block">黑名單限制</span>
                    <span className="text-[11px] text-gray-500">開啟後禁止該顧客線上預約</span>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={localMember.is_blacklisted}
                      onChange={(e) => handleUpdateMember(localMember.id, { is_blacklisted: e.target.checked })}
                    />
                    <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-500"></div>
                  </label>
                </div>

                <div className="flex-1 flex flex-col">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-bold text-[#3E332B]">📌 店家內部備註</span>
                    {isSavingNotes && <span className="text-xs text-[#8B5B43] font-bold">自動儲存中...</span>}
                  </div>
                  <textarea
                    key={localMember.id}
                    className="w-full flex-1 min-h-[76px] p-2.5 bg-white border border-[#E8DEC8] rounded-xl text-sm focus:border-[#8B5B43] outline-none resize-none text-[#3E332B]"
                    placeholder="填寫關於此顧客的備註事項（點擊空白處自動儲存）..."
                    defaultValue={localMember.notes || ''}
                    onBlur={(e) => {
                      if (e.target.value !== (localMember.notes || '')) {
                        handleUpdateMember(localMember.id, { notes: e.target.value });
                      }
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Section 2: Dual-Track Statistics Cards (不限時封頂人次 vs 一般計時時長) */}
            <div>
              <div className="flex items-center justify-between mb-2.5">
                <h3 className="text-sm font-bold text-[#3E332B]">
                  📊 會員累計消費與時數統計（僅計入已報到／已結帳之有效訂單，含同行人數與拆帳明細）
                </h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
                {/* Card 1: Unlimited Capped Pax Count */}
                <div className="bg-amber-50/80 border border-amber-300 rounded-2xl p-4 shadow-2xs">
                  <div className="flex items-center justify-between text-amber-800 mb-1">
                    <span className="text-xs font-bold">✨ 不限時 (封頂) 累計</span>
                    <Sparkles className="w-4 h-4 text-amber-600" />
                  </div>
                  <div className="text-2xl font-black text-amber-950">
                    {stats.unlimited_pax_count} <span className="text-sm font-bold text-amber-800">人次</span>
                  </div>
                  <div className="text-[11px] text-amber-800/90 mt-1 font-bold">
                    共 {stats.unlimited_orders_count} 筆不限時結帳（已乘算同行人數）
                  </div>
                </div>

                {/* Card 2: Regular Hourly Cumulative Hours */}
                <div className="bg-[#FAF7F2] border border-[#E8DEC8] rounded-2xl p-4 shadow-2xs">
                  <div className="flex items-center justify-between text-[#8B5B43] mb-1">
                    <span className="text-xs font-bold">⏱️ 一般計時時長累計</span>
                    <Clock className="w-4 h-4 text-[#8B5B43]" />
                  </div>
                  <div className="text-2xl font-black text-[#3E332B]">
                    {stats.regular_person_hours} <span className="text-sm font-bold text-[#8C8279]">小時 (人時)</span>
                  </div>
                  <div className="text-[11px] text-[#8C8279] mt-1 font-bold">
                    純時段長 {stats.regular_pure_hours} 小時 ｜ 共 {stats.regular_orders_count} 筆計時
                  </div>
                </div>

                {/* Card 3: Total Spent */}
                <div className="bg-[#FAF7F2] border border-[#E8DEC8] rounded-2xl p-4 shadow-2xs">
                  <div className="flex items-center justify-between text-[#8B5B43] mb-1">
                    <span className="text-xs font-bold">💰 歷史累計結帳總額</span>
                  </div>
                  <div className="text-2xl font-black text-[#8B5B43]">
                    NT$ {(stats.total_spent || 0).toLocaleString()}
                  </div>
                  <div className="text-[11px] text-[#8C8279] mt-1 font-bold">
                    實際到訪完成 {stats.completed_visits_count} 次預約
                  </div>
                </div>

                {/* Card 4: Attendance Breakdown */}
                <div className="bg-white border border-[#E8DEC8] rounded-2xl p-4 flex flex-col justify-between shadow-2xs">
                  <div className="text-xs font-bold text-[#8C8279] mb-1">📋 預約出席信用紀錄</div>
                  <div className="grid grid-cols-3 gap-1 text-center my-1">
                    <div className="bg-[#FAF7F2] rounded-lg py-1.5 border border-[#E8DEC8]">
                      <div className="text-base font-black text-emerald-700">{stats.completed_visits_count}</div>
                      <div className="text-[10px] text-[#8C8279] font-bold">完訪</div>
                    </div>
                    <div className="bg-[#FAF7F2] rounded-lg py-1.5 border border-[#E8DEC8]">
                      <div className="text-base font-black text-[#6D5D52]">{stats.cancelled_count}</div>
                      <div className="text-[10px] text-[#8C8279] font-bold">取消</div>
                    </div>
                    <div className="bg-rose-50 rounded-lg py-1.5 border border-rose-200">
                      <div className="text-base font-black text-rose-700">{stats.no_show_count}</div>
                      <div className="text-[10px] text-rose-600 font-bold">爽約</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Section 3: Tabs for Reservation History & 2-Month Login Logs */}
            <div>
              <div className="flex items-center gap-2 border-b border-[#E8DEC8] mb-4">
                <button
                  type="button"
                  onClick={() => setActiveTab('reservations')}
                  className={`px-4 py-2.5 text-sm font-bold border-b-2 transition-colors flex items-center gap-2 ${
                    activeTab === 'reservations'
                      ? 'border-[#8B5B43] text-[#8B5B43]'
                      : 'border-transparent text-[#8C8279] hover:text-[#3E332B]'
                  }`}
                >
                  <Calendar className="w-4 h-4" />
                  歷史預約紀錄 ({groupedReservations.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('login_logs')}
                  className={`px-4 py-2.5 text-sm font-bold border-b-2 transition-colors flex items-center gap-2 ${
                    activeTab === 'login_logs'
                      ? 'border-[#8B5B43] text-[#8B5B43]'
                      : 'border-transparent text-[#8C8279] hover:text-[#3E332B]'
                  }`}
                >
                  <Smartphone className="w-4 h-4" />
                  近 2 個月登入與裝置紀錄 ({loginLogs.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('passes')}
                  className={`px-4 py-2.5 text-sm font-bold border-b-2 transition-colors flex items-center gap-2 ${
                    activeTab === 'passes'
                      ? 'border-[#8B5B43] text-[#8B5B43]'
                      : 'border-transparent text-[#8C8279] hover:text-[#3E332B]'
                  }`}
                >
                  <Ticket className="w-4 h-4" />
                  卡券與集次卡 ({userPasses.length})
                </button>
              </div>

              {/* Tab 1: Reservations */}
              {activeTab === 'reservations' && (
                isMemberLoading ? (
                  <div className="py-8 flex justify-center">
                    <div className="w-6 h-6 border-2 border-gray-200 border-t-gray-800 rounded-full animate-spin" />
                  </div>
                ) : groupedReservations.length === 0 ? (
                  <div className="text-center py-8 text-gray-400 bg-gray-50 rounded-xl border border-gray-100">
                    尚無預約紀錄
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {groupedReservations.map(r => {
                      const rFormatted = {
                        ...r,
                        start_time: r.session?.start_time,
                        session_date: r.session?.session_date
                      };
                      const statusUI = getReservationStatusUI(rFormatted);
                      const isCancelled = r.status === 'cancelled';
                      return (
                        <div
                          key={r.booking_ref}
                          onClick={() => setSelectedReservation({ ...r, user: localMember })}
                          className={`p-4 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 cursor-pointer hover:shadow-md transition-all ${
                            isCancelled ? 'bg-gray-50 border-gray-100' : 'bg-white border-[#E8DEC8] hover:border-[#8B5B43]'
                          }`}
                        >
                          <div className="flex items-center gap-4">
                            <div
                              className={`w-12 h-12 rounded-xl flex flex-col items-center justify-center shrink-0 ${
                                isCancelled ? 'bg-gray-100 text-gray-400' : 'bg-[#3E332B] text-[#FAF7F2]'
                              }`}
                            >
                              <span className="text-xs font-bold">
                                {format(new Date(r.session.session_date), 'MM/dd')}
                              </span>
                            </div>
                            <div>
                              <div className="flex items-center flex-wrap gap-2">
                                <span className={`font-bold ${isCancelled ? 'text-gray-400 line-through' : 'text-[#3E332B]'}`}>
                                  {r.session.start_time} - {r.session.end_time}
                                </span>
                                <span className="text-xs bg-[#FAF7F2] text-[#6D5D52] border border-[#E8DEC8] font-bold px-2 py-0.5 rounded-full">
                                  {r.pax} 人 · {r.session_count} 小時
                                </span>
                                {r.is_unlimited && (
                                  <span className="text-xs bg-amber-100 text-amber-900 border border-amber-300 font-bold px-2 py-0.5 rounded-full">
                                    ✨ 不限時封頂
                                  </span>
                                )}
                                {r.is_paid && (
                                  <span className="text-xs bg-amber-100 text-amber-800 font-bold px-2 py-0.5 rounded-full">
                                    💰 已結帳 NT$ {r.total_amount || 0}
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-gray-500 mt-1 flex items-center gap-3">
                                <span>單號: {r.booking_ref.slice(0, 8)}...</span>
                                {!r.is_paid && r.total_amount != null && (
                                  <span>預估金額: NT$ {r.total_amount}</span>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 self-end sm:self-center">
                            <span className={`inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-lg ${statusUI.bgClass} ${statusUI.colorClass}`}>
                              {statusUI.icon} {statusUI.text}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              )}



              {/* Tab 2: 2-Month Login & Device Logs */}
              {activeTab === 'login_logs' && (
                isLogsLoading ? (
                  <div className="py-8 flex justify-center">
                    <div className="w-6 h-6 border-2 border-gray-200 border-t-gray-800 rounded-full animate-spin" />
                  </div>
                ) : loginLogs.length === 0 ? (
                  <div className="text-center py-8 text-gray-400 bg-gray-50 rounded-xl border border-gray-100">
                    近 2 個月（60 天）內尚無登入紀錄
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    <p className="text-xs text-gray-500 mb-2">
                      💡 系統自動記錄顧客透過 LINE 登入或開啟預約網頁之 IP 與硬體環境，並於每日午夜自動清除超過 60 天之舊紀錄。
                    </p>
                    <div className="overflow-x-auto border border-gray-200 rounded-xl">
                      <table className="w-full text-left text-xs whitespace-nowrap">
                        <thead>
                          <tr className="bg-gray-50 text-gray-600 border-b border-gray-200">
                            <th className="px-4 py-3 font-bold">登入/開啟時間</th>
                            <th className="px-4 py-3 font-bold">外部 IP 位址</th>
                            <th className="px-4 py-3 font-bold">手機型號 / 裝置</th>
                            <th className="px-4 py-3 font-bold">作業系統</th>
                            <th className="px-4 py-3 font-bold">瀏覽器 / LINE 版本</th>
                            <th className="px-4 py-3 font-bold">螢幕與網路規格</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {loginLogs.map(log => (
                            <tr key={log.id} className="hover:bg-gray-50">
                              <td className="px-4 py-3 font-mono text-gray-800 font-medium">
                                {format(new Date(log.created_at), 'yyyy/MM/dd HH:mm:ss')}
                              </td>
                              <td className="px-4 py-3 font-mono">
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#FAF7F2] text-[#3E332B] border border-[#E8DEC8] font-semibold">
                                  <Globe className="w-3 h-3 text-[#8B5B43]" />
                                  {log.ip_address || '未知'}
                                </span>
                              </td>
                              <td className="px-4 py-3 font-bold text-gray-800">
                                {log.device_model || '未知裝置'}
                              </td>
                              <td className="px-4 py-3 text-gray-600 font-medium">
                                {log.os || '—'}
                              </td>
                              <td className="px-4 py-3">
                                <span className={`px-2 py-0.5 rounded-full font-semibold ${
                                  log.browser?.includes('LINE')
                                    ? 'bg-[#06C755]/10 text-[#059941]'
                                    : 'bg-[#FAF7F2] text-[#6D5D52] border border-[#E8DEC8]'
                                }`}>
                                  {log.browser || '一般瀏覽器'}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-gray-500 font-mono">
                                <span className="inline-flex items-center gap-1">
                                  <Monitor className="w-3 h-3 text-gray-400" />
                                  {log.screen_info || '—'}
                                  {log.language ? ` (${log.language})` : ''}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )
              )}

              {/* Tab 3: Member Passes & Punch Cards */}
              {activeTab === 'passes' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between bg-[#FAF7F2] p-4 rounded-xl border border-[#E8DEC8]">
                    <div>
                      <h4 className="text-sm font-bold text-[#3E332B] flex items-center gap-2">
                        <Ticket className="w-4 h-4 text-[#8B5B43]" />
                        名下卡券與集次卡清單
                      </h4>
                      <p className="text-xs text-[#8C8279] mt-0.5">
                        支援燙布/熨燙計次卡、折扣券、包月暢遊卡現場扣抵核銷與發放
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowGrantModal(true)}
                      className="px-3.5 py-2 bg-[#8B5B43] hover:bg-[#724834] text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors shadow-xs shrink-0"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      發放卡券給此會員
                    </button>
                  </div>

                  {isPassesLoading ? (
                    <div className="py-8 flex justify-center">
                      <div className="w-6 h-6 border-2 border-gray-200 border-t-gray-800 rounded-full animate-spin" />
                    </div>
                  ) : userPasses.length === 0 ? (
                    <div className="text-center py-12 text-[#8C8279] bg-[#FAF7F2] rounded-2xl border border-dashed border-[#E8DEC8] space-y-3">
                      <Ticket className="w-10 h-10 mx-auto text-[#8C8279]/50" />
                      <p className="text-sm font-bold">此會員名下尚無任何卡券或集次卡</p>
                      <button
                        type="button"
                        onClick={() => setShowGrantModal(true)}
                        className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#8B5B43] text-white text-xs font-bold rounded-xl shadow-xs hover:bg-[#724834]"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        立即手動發放卡券
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {userPasses.map((p) => {
                        const isExpanded = expandedLogPassId === p.id;
                        const logs = Array.isArray(p.usage_logs_json) ? p.usage_logs_json : [];
                        const isExpired = p.expires_at && new Date() > new Date(p.expires_at);
                        const isExhausted = p.remaining_quota !== null && p.remaining_quota <= 0;
                        const isActive = p.status === 'ACTIVE' && !isExpired && !isExhausted;

                        return (
                          <div
                            key={p.id}
                            className={`p-4 rounded-2xl border transition-all ${
                              isActive
                                ? 'bg-white border-[#E8DEC8] hover:border-[#8B5B43] shadow-2xs'
                                : 'bg-[#FAF7F2]/60 border-gray-200 opacity-80'
                            }`}
                          >
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                              <div className="space-y-1.5 min-w-0">
                                <div className="flex items-center flex-wrap gap-2">
                                  <span className="text-base font-bold text-[#3E332B]">
                                    {p.plan?.name || '專屬集次/暢遊卡'}
                                  </span>
                                  {isActive ? (
                                    <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold">
                                      有效中
                                    </span>
                                  ) : isExpired ? (
                                    <span className="text-xs px-2.5 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 font-bold">
                                      已逾期
                                    </span>
                                  ) : isExhausted ? (
                                    <span className="text-xs px-2.5 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200 font-bold">
                                      已用罄
                                    </span>
                                  ) : (
                                    <span className="text-xs px-2.5 py-0.5 rounded-full bg-zinc-100 text-zinc-600 border border-zinc-200 font-bold">
                                      {p.status}
                                    </span>
                                  )}
                                  {p.day_restriction === 'WEEKDAY_ONLY' && (
                                    <span className="text-[11px] px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-bold">
                                      僅限平日
                                    </span>
                                  )}
                                  {p.day_restriction === 'WEEKEND_ONLY' && (
                                    <span className="text-[11px] px-2 py-0.5 rounded bg-amber-50 text-amber-700 font-bold">
                                      僅限假日
                                    </span>
                                  )}
                                </div>

                                <div className="flex items-center gap-2 text-xs text-[#6D5D52]">
                                  <span className="font-mono bg-[#FAF7F2] px-2 py-0.5 rounded border border-[#E8DEC8] font-bold">
                                    卡號: {p.pass_code}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => handleCopyCode(p.pass_code)}
                                    className="p-1 text-gray-400 hover:text-[#8B5B43] transition-colors"
                                    title="複製卡號"
                                  >
                                    {copiedCode === p.pass_code ? (
                                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                                    ) : (
                                      <Copy className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                  <span className="text-gray-300">|</span>
                                  <span>
                                    效期：{p.expires_at ? format(new Date(p.expires_at), 'yyyy/MM/dd') : '永久有效'}
                                  </span>
                                </div>

                                {p.notes && (
                                  <p className="text-xs text-[#8C8279] italic">
                                    備註：{p.notes}
                                  </p>
                                )}
                              </div>

                              <div className="flex items-center gap-3 shrink-0 self-end sm:self-center">
                                <div className="text-right">
                                  <div className="text-xs text-[#8C8279] font-medium">剩餘額度</div>
                                  <div className="text-lg font-black text-[#8B5B43]">
                                    {p.remaining_quota !== null ? (
                                      <span>{p.remaining_quota} <span className="text-xs font-normal text-gray-500">/ {p.initial_quota || p.remaining_quota} 次</span></span>
                                    ) : (
                                      <span className="text-emerald-700 text-sm">暢遊無限制</span>
                                    )}
                                  </div>
                                </div>

                                <button
                                  type="button"
                                  onClick={() => handleRedeemPass(p)}
                                  disabled={!isActive || redeemingPassId === p.id}
                                  className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-xs flex items-center gap-1.5"
                                >
                                  {redeemingPassId === p.id ? '核銷中...' : '現場扣抵 1 次'}
                                </button>

                                <button
                                  type="button"
                                  onClick={() => setExpandedLogPassId(isExpanded ? null : p.id)}
                                  className="p-2 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
                                  title="核銷明細紀錄"
                                >
                                  {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                </button>
                              </div>
                            </div>

                            {/* Collapsible usage logs */}
                            {isExpanded && (
                              <div className="mt-3 pt-3 border-t border-[#E8DEC8]/60">
                                <div className="text-xs font-bold text-[#6D5D52] mb-2 flex items-center justify-between">
                                  <span>📜 使用與核銷歷史明細 ({logs.length} 筆)</span>
                                </div>
                                {logs.length === 0 ? (
                                  <p className="text-xs text-gray-400 py-1">尚無任何核銷使用紀錄</p>
                                ) : (
                                  <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                                    {logs.map((log, idx) => (
                                      <div
                                        key={idx}
                                        className="text-xs bg-[#FAF7F2] p-2 rounded-lg border border-[#E8DEC8] flex items-center justify-between font-mono"
                                      >
                                        <div className="flex items-center gap-2">
                                          <span className="text-gray-500">{log.date}</span>
                                          <span className="font-bold text-gray-800">
                                            扣抵 {log.deducted || 1} 次
                                          </span>
                                          {log.note && (
                                            <span className="text-gray-600">({log.note})</span>
                                          )}
                                        </div>
                                        <span className="text-gray-400 text-[11px]">經辦：{log.staff || '門市'}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Grant Pass Modal */}
      {showGrantModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200">
          <div className="bg-white rounded-3xl max-w-lg w-full p-6 shadow-2xl border border-[#E8DEC8] space-y-5">
            <div className="flex items-center justify-between border-b border-gray-100 pb-4">
              <div>
                <h3 className="text-lg font-bold text-[#3E332B] flex items-center gap-2">
                  <Ticket className="w-5 h-5 text-[#8B5B43]" />
                  發放卡券 / 集次卡
                </h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  發放對象：{localMember.name} ({localMember.phone || '無電話'})
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowGrantModal(false)}
                className="p-1.5 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleGrantPass} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">選擇方案 *</label>
                <select
                  value={grantForm.plan_id}
                  onChange={(e) => {
                    const selectedId = e.target.value;
                    const found = plansList.find(p => String(p.id) === selectedId);
                    setGrantForm(prev => ({
                      ...prev,
                      plan_id: selectedId,
                      custom_quota: found?.total_quota != null ? String(found.total_quota) : '',
                      valid_days: found?.valid_days != null ? String(found.valid_days) : '90',
                      day_restriction: found?.day_restriction || 'ALL'
                    }));
                  }}
                  className="w-full px-3.5 py-2.5 bg-[#FAF7F2] border border-[#E8DEC8] rounded-xl text-sm font-bold text-[#3E332B] focus:border-[#8B5B43] outline-none"
                >
                  <option value="">-- 自訂卡券 (無方案綁定) --</option>
                  {plansList.map(plan => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name} (NT$ {plan.price || 0} / {plan.total_quota != null ? `${plan.total_quota}次` : '無限次'})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-gray-700 mb-1">
                    總次數 / 額度
                    <span className="text-[10px] text-gray-400 font-normal ml-1">(留空為暢遊無限制)</span>
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={grantForm.custom_quota}
                    onChange={(e) => setGrantForm(prev => ({ ...prev, custom_quota: e.target.value }))}
                    placeholder="例: 5"
                    className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-xl text-sm font-bold text-[#3E332B] focus:border-[#8B5B43] outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-700 mb-1">
                    有效天數
                    <span className="text-[10px] text-gray-400 font-normal ml-1">(自今日起算)</span>
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={grantForm.valid_days}
                    onChange={(e) => setGrantForm(prev => ({ ...prev, valid_days: e.target.value }))}
                    placeholder="例: 90"
                    className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-xl text-sm font-bold text-[#3E332B] focus:border-[#8B5B43] outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">適用平假日限制</label>
                <select
                  value={grantForm.day_restriction}
                  onChange={(e) => setGrantForm(prev => ({ ...prev, day_restriction: e.target.value }))}
                  className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-xl text-sm font-bold text-[#3E332B] focus:border-[#8B5B43] outline-none"
                >
                  <option value="ALL">全時段通用 (平日與假日皆可)</option>
                  <option value="WEEKDAY_ONLY">僅限週一至週五 (平日限定)</option>
                  <option value="WEEKEND_ONLY">僅限週六週日 (假日限定)</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-gray-700 mb-1">
                    每日時數上限
                    <span className="text-[10px] text-gray-400 font-normal ml-1">(可留空)</span>
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={grantForm.max_hours_per_day}
                    onChange={(e) => setGrantForm(prev => ({ ...prev, max_hours_per_day: e.target.value }))}
                    placeholder="不限時數"
                    className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-xl text-sm font-bold text-[#3E332B] focus:border-[#8B5B43] outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-700 mb-1">
                    每週到店天數
                    <span className="text-[10px] text-gray-400 font-normal ml-1">(可留空)</span>
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="7"
                    value={grantForm.max_days_per_week}
                    onChange={(e) => setGrantForm(prev => ({ ...prev, max_days_per_week: e.target.value }))}
                    placeholder="不限天數"
                    className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-xl text-sm font-bold text-[#3E332B] focus:border-[#8B5B43] outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">管理員備註說明</label>
                <input
                  type="text"
                  value={grantForm.note}
                  onChange={(e) => setGrantForm(prev => ({ ...prev, note: e.target.value }))}
                  placeholder="例: 會員生日贈禮、現場購買5次燙布卡"
                  className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-xl text-sm font-bold text-[#3E332B] focus:border-[#8B5B43] outline-none"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setShowGrantModal(false)}
                  className="px-4 py-2 border border-gray-300 text-gray-600 text-sm font-bold rounded-xl hover:bg-gray-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={isGranting}
                  className="px-5 py-2 bg-[#8B5B43] hover:bg-[#724834] text-white text-sm font-bold rounded-xl shadow-xs transition-colors disabled:opacity-50"
                >
                  {isGranting ? '發放中...' : '確認發放卡券'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reservation Details Modal (Stacked on top) */}
      <ReservationDetailsModal 
        reservation={selectedReservation} 
        onClose={() => setSelectedReservation(null)} 
        onUpdate={(updates) => {
          if (updates) {
            setSelectedReservation(prev => ({ ...prev, ...updates }));
          } else {
            setSelectedReservation(null);
          }
          fetchMemberReservations();
          refreshMemberDetails();
        }} 
      />

      {/* Send LINE Message Modal */}
      <SendLineMessageModal
        isOpen={showLineModal}
        onClose={() => setShowLineModal(false)}
        user={localMember}
      />
    </>
  );
}
