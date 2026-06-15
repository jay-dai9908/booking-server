import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { Search, XCircle, CheckCircle2 } from 'lucide-react';
import api from '../../api/axios';
import MemberDetailsModal from '../../components/MemberDetailsModal';

export default function MembersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [users, setUsers] = useState([]);
  const [memberSearchQuery, setMemberSearchQuery] = useState('');
  const [selectedMember, setSelectedMember] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    fetchUsers();
  }, []);

  useEffect(() => {
    if (users.length > 0) {
      const userId = searchParams.get('userId');
      if (userId) {
        const user = users.find(u => u.id === parseInt(userId, 10));
        if (user) {
          setSelectedMember(user);
        }
      }
    }
  }, [users, searchParams]);

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

  const handleSelectMember = (user) => {
    setSelectedMember(user);
    if (user) {
      setSearchParams({ userId: user.id });
    } else {
      setSearchParams({});
    }
  };

  return (
    <>
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

      </div>

      <MemberDetailsModal 
        member={selectedMember} 
        onClose={() => handleSelectMember(null)}
        onMemberUpdated={(updatedUser) => {
          setUsers(users.map(u => u.id === updatedUser.id ? updatedUser : u));
        }}
      />

      <style dangerouslySetInnerHTML={{__html: `
        .animate-in { animation: animateIn 0.4s ease-out forwards; }
        @keyframes animateIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      `}} />
    </>
  );
}
