import React, { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { UserCog, X, CheckCircle2, XCircle } from 'lucide-react';
import api from '../api/axios';
import ReservationDetailsModal, { getReservationStatusUI } from './ReservationDetailsModal';

export default function MemberDetailsModal({ member, onClose, onMemberUpdated }) {
  const [memberReservations, setMemberReservations] = useState([]);
  const [isMemberLoading, setIsMemberLoading] = useState(false);
  const [isSavingNotes, setIsSavingNotes] = useState(false);
  const [selectedReservation, setSelectedReservation] = useState(null);

  // We use a local copy of member for optimistic updates
  const [localMember, setLocalMember] = useState(member);

  useEffect(() => {
    setLocalMember(member);
    if (member) {
      fetchMemberReservations();
    }
  }, [member]);

  const fetchMemberReservations = async () => {
    setIsMemberLoading(true);
    try {
      const res = await api.get(`/users/${member.id}/reservations`);
      setMemberReservations(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setIsMemberLoading(false);
    }
  };

  const handleUpdateMember = async (id, data) => {
    setIsSavingNotes(true);
    try {
      const res = await api.put(`/users/${id}`, data);
      setLocalMember(res.data.user);
      if (onMemberUpdated) onMemberUpdated(res.data.user);
    } catch (err) {
      console.error(err);
      alert('更新失敗');
    } finally {
      setIsSavingNotes(false);
    }
  };

  if (!member || !localMember) return null;

  return (
    <>
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl overflow-hidden relative z-10 animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
            <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
              <UserCog className="w-5 h-5 text-gray-500" />
              會員詳細資料
            </h2>
            <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-200 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
          
          <div className="p-6 overflow-y-auto flex-1">
            {/* Member Info & Controls */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-1">顧客姓名</h3>
                  <p className="text-lg font-bold text-gray-900">{localMember.name || '未設定'}</p>
                </div>
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-1">聯絡電話</h3>
                  <p className="text-lg font-bold text-gray-900">{localMember.phone || '未提供'}</p>
                </div>
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-1">註冊時間</h3>
                  <p className="text-md text-gray-800">{format(new Date(localMember.created_at), 'yyyy/MM/dd HH:mm')}</p>
                </div>
              </div>
              <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-gray-700">黑名單狀態</span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" className="sr-only peer" checked={localMember.is_blacklisted} 
                      onChange={(e) => handleUpdateMember(localMember.id, { is_blacklisted: e.target.checked })} />
                    <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-500"></div>
                  </label>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-bold text-gray-700">會員備註</span>
                    {isSavingNotes && <span className="text-xs text-gray-400">儲存中...</span>}
                  </div>
                  <textarea 
                    className="w-full h-24 p-3 bg-white border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-gray-900 outline-none resize-none"
                    placeholder="填寫關於此顧客的備註事項..."
                    defaultValue={localMember.notes || ''}
                    onBlur={(e) => {
                      if (e.target.value !== (localMember.notes || '')) {
                        handleUpdateMember(localMember.id, { notes: e.target.value });
                      }
                    }}
                  />
                  <p className="text-xs text-gray-400 mt-1">輸入完畢後點擊空白處即可自動儲存</p>
                </div>
              </div>
            </div>

            {/* Reservation History */}
            <h3 className="text-lg font-bold text-gray-800 mb-4 border-b border-gray-100 pb-2">歷史預約紀錄</h3>
            {isMemberLoading ? (
              <div className="py-8 flex justify-center"><div className="w-6 h-6 border-2 border-gray-200 border-t-gray-800 rounded-full animate-spin" /></div>
            ) : memberReservations.length === 0 ? (
              <div className="text-center py-8 text-gray-400 bg-gray-50 rounded-xl border border-gray-100">無預約紀錄</div>
            ) : (
              <div className="space-y-3">
                {Object.values(memberReservations.reduce((acc, curr) => {
                  const ref = curr.booking_ref;
                  if (!acc[ref]) {
                    acc[ref] = { ...curr, session: { ...curr.session }, session_count: 1 };
                  } else {
                    acc[ref].session_count += 1;
                    if (curr.session.end_time > acc[ref].session.end_time) acc[ref].session.end_time = curr.session.end_time;
                    if (curr.session.start_time < acc[ref].session.start_time) acc[ref].session.start_time = curr.session.start_time;
                  }
                  return acc;
                }, {})).sort((a, b) => new Date(b.session.session_date) - new Date(a.session.session_date) || b.session.start_time.localeCompare(a.session.start_time)).map(r => {
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
                      className={`p-4 rounded-xl border flex items-center justify-between cursor-pointer hover:shadow-md transition-shadow ${isCancelled ? 'bg-gray-50 border-gray-100' : 'bg-white border-gray-200'}`}
                    >
                      <div className="flex items-center gap-4">
                        <div className={`w-12 h-12 rounded-lg flex flex-col items-center justify-center ${isCancelled ? 'bg-gray-100 text-gray-400' : 'bg-gray-900 text-white'}`}>
                          <span className="text-xs font-medium">{format(new Date(r.session.session_date), 'MM/dd')}</span>
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className={`font-bold ${isCancelled ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                              {r.session.start_time} - {r.session.end_time}
                            </span>
                            <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{r.pax} 人</span>
                          </div>
                          <div className="text-xs text-gray-500 mt-1">訂單編號: {r.booking_ref.slice(0,8)}...</div>
                        </div>
                      </div>
                      <div>
                        <span className={`inline-flex items-center gap-1 text-xs font-medium ${statusUI.colorClass}`}>
                          {statusUI.icon} {statusUI.text}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

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
        }} 
      />
    </>
  );
}
