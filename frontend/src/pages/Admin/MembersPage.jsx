import React, { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { Search, UserCog, X, XCircle, CheckCircle2 } from 'lucide-react';
import api from '../../api/axios';

export default function MembersPage() {
  const [users, setUsers] = useState([]);
  const [memberSearchQuery, setMemberSearchQuery] = useState('');
  const [selectedMember, setSelectedMember] = useState(null);
  const [memberReservations, setMemberReservations] = useState([]);
  const [isMemberLoading, setIsMemberLoading] = useState(false);
  const [isSavingNotes, setIsSavingNotes] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    setIsLoading(true);
    try {
      const res = await api.get('/users');
      setUsers(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectMember = async (user) => {
    setSelectedMember(user);
    setIsMemberLoading(true);
    try {
      const res = await api.get(`/users/${user.id}/reservations`);
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
      setUsers(users.map(u => u.id === id ? res.data.user : u));
      setSelectedMember(res.data.user);
    } catch (err) {
      console.error(err);
      alert('更新失敗');
    } finally {
      setIsSavingNotes(false);
    }
  };

  return (
    <div className="p-4 md:p-8 space-y-8 animate-fade-in">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">會員管理</h1>
          <p className="text-gray-500 mt-1 text-sm">管理顧客資料、歷史預約及黑名單狀態。</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-gray-400" />
            </div>
            <input
              type="text"
              placeholder="搜尋姓名或電話..."
              value={memberSearchQuery}
              onChange={(e) => setMemberSearchQuery(e.target.value)}
              className="pl-10 pr-4 py-2 bg-white border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none text-sm transition-shadow w-full md:w-64"
            />
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          {isLoading ? (
            <div className="p-10 flex justify-center"><div className="w-8 h-8 border-4 border-gray-200 border-t-gray-800 rounded-full animate-spin" /></div>
          ) : (
            <table className="w-full text-left whitespace-nowrap">
              <thead>
                <tr className="bg-gray-50 text-gray-500 text-sm border-b border-gray-200">
                  <th className="px-6 py-4 font-medium">顧客資料</th>
                  <th className="px-6 py-4 font-medium">註冊時間</th>
                  <th className="px-6 py-4 font-medium">狀態</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {users.filter(u => {
                  if (!memberSearchQuery) return true;
                  const q = memberSearchQuery.toLowerCase();
                  return (u.name?.toLowerCase() || '').includes(q) || (u.phone?.toLowerCase() || '').includes(q);
                }).length === 0 ? (
                  <tr><td colSpan="3" className="text-center py-16 text-gray-400">{memberSearchQuery ? '找不到符合條件的會員' : '目前尚無會員紀錄'}</td></tr>
                ) : (
                  users.filter(u => {
                    if (!memberSearchQuery) return true;
                    const q = memberSearchQuery.toLowerCase();
                    return (u.name?.toLowerCase() || '').includes(q) || (u.phone?.toLowerCase() || '').includes(q);
                  }).map(u => (
                      <tr key={u.id} onClick={() => handleSelectMember(u)} className="hover:bg-gray-50 transition-colors cursor-pointer">
                        <td className="px-6 py-4">
                          <div className="flex flex-col">
                            <span className={`font-medium ${u.is_blacklisted ? 'text-gray-400 line-through' : 'text-gray-800'}`}>{u.name || '未設定'}</span>
                            <span className="text-sm text-gray-500">{u.phone || '未提供'}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500">
                          {format(new Date(u.created_at), 'yyyy/MM/dd')}
                        </td>
                        <td className="px-6 py-4">
                          {u.is_blacklisted ? 
                            <span className="inline-flex items-center gap-1.5 text-red-500 text-sm bg-red-50 px-2 py-1 rounded-md"><XCircle className="w-4 h-4"/>黑名單</span> : 
                            <span className="inline-flex items-center gap-1.5 text-gray-500 text-sm">正常</span>}
                        </td>
                      </tr>
                    ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Member Details Modal */}
      {selectedMember && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={() => setSelectedMember(null)} />
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl overflow-hidden relative z-10 animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
              <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                <UserCog className="w-5 h-5 text-gray-500" />
                會員詳細資料
              </h2>
              <button onClick={() => setSelectedMember(null)} className="p-2 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-200 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto flex-1">
              {/* Member Info & Controls */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                <div className="space-y-4">
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">顧客姓名</h3>
                    <p className="text-lg font-bold text-gray-900">{selectedMember.name || '未設定'}</p>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">聯絡電話</h3>
                    <p className="text-lg font-bold text-gray-900">{selectedMember.phone || '未提供'}</p>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">註冊時間</h3>
                    <p className="text-md text-gray-800">{format(new Date(selectedMember.created_at), 'yyyy/MM/dd HH:mm')}</p>
                  </div>
                </div>
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-gray-700">黑名單狀態</span>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" className="sr-only peer" checked={selectedMember.is_blacklisted} 
                        onChange={(e) => handleUpdateMember(selectedMember.id, { is_blacklisted: e.target.checked })} />
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
                      defaultValue={selectedMember.notes || ''}
                      onBlur={(e) => {
                        if (e.target.value !== (selectedMember.notes || '')) {
                          handleUpdateMember(selectedMember.id, { notes: e.target.value });
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
                    const isCancelled = r.status === 'cancelled';
                    return (
                      <div key={r.booking_ref} className={`p-4 rounded-xl border flex items-center justify-between ${isCancelled ? 'bg-gray-50 border-gray-100' : 'bg-white border-gray-200'}`}>
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
                          {isCancelled ? 
                            <span className="inline-flex items-center gap-1 text-gray-400 text-xs font-medium"><XCircle className="w-3.5 h-3.5"/> 已取消</span> : 
                            <span className="inline-flex items-center gap-1 text-green-600 text-xs font-medium"><CheckCircle2 className="w-3.5 h-3.5"/> 預約成功</span>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <style dangerouslySetInnerHTML={{__html: `
        .animate-in { animation: animateIn 0.4s ease-out forwards; }
        @keyframes animateIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      `}} />
    </div>
  );
}
