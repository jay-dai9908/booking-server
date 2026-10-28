import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { 
  Search, 
  XCircle, 
  Sparkles, 
  Clock, 
  AlertTriangle, 
  User, 
  MessageCircle,
  QrCode,
  Ticket,
  CheckCircle2,
  X
} from 'lucide-react';
import api from '../../api/axios';
import MemberDetailsModal from '../../components/MemberDetailsModal';
import SendLineMessageModal from '../../components/SendLineMessageModal';

export default function MembersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [users, setUsers] = useState([]);
  const [memberSearchQuery, setMemberSearchQuery] = useState('');
  const [selectedMember, setSelectedMember] = useState(null);
  const [lineMessageTargetUser, setLineMessageTargetUser] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  
  // Pagination
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalRecords, setTotalRecords] = useState(0);

  // Quick Barcode Scan & Redeem State
  const [showScanModal, setShowScanModal] = useState(false);
  const [scanCodeInput, setScanCodeInput] = useState('');
  const [scanResult, setScanResult] = useState(null);
  const [isRedeemingCode, setIsRedeemingCode] = useState(false);

  useEffect(() => {
    const delayDebounceFn = setTimeout(() => {
      fetchUsers();
    }, 300);
    return () => clearTimeout(delayDebounceFn);
  }, [page, memberSearchQuery]);

  useEffect(() => {
    const userId = searchParams.get('userId');
    if (userId) {
      const parsedId = parseInt(userId, 10);
      const user = users.find(u => u.id === parsedId);
      if (user) {
        setSelectedMember(user);
      } else {
        api.get(`/users/${parsedId}`)
          .then(res => {
            setSelectedMember(res.data);
          })
          .catch(err => {
            console.error('Failed to fetch specific user:', err);
          });
      }
    }
  }, [users, searchParams]);

  const fetchUsers = async () => {
    setIsLoading(true);
    try {
      const res = await api.get(`/users?page=${page}&limit=20&search=${encodeURIComponent(memberSearchQuery)}`);
      setUsers(res.data?.data || (Array.isArray(res.data) ? res.data : []));
      setTotalPages(res.data?.totalPages || 1);
      setTotalRecords(res.data?.total || (Array.isArray(res.data) ? res.data.length : 0));
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

  const handleQuickRedeem = async (e) => {
    if (e) e.preventDefault();
    const code = scanCodeInput.trim();
    if (!code) return;
    setIsRedeemingCode(true);
    setScanResult(null);
    try {
      const res = await api.post('/passes/admin/redeem', {
        pass_code: code,
        deduct_amount: 1,
        note: '櫃檯快速條碼核銷'
      });
      setScanResult({
        success: true,
        message: '卡券核銷成功！已成功現場扣抵 1 次',
        data: res.data
      });
      setScanCodeInput('');
      fetchUsers();
    } catch (err) {
      setScanResult({
        success: false,
        message: err.response?.data?.error || '核銷失敗，請檢查條碼是否正確或卡券已用罄'
      });
    } finally {
      setIsRedeemingCode(false);
    }
  };

  return (
    <>
      <div className="p-4 md:p-8 space-y-6 animate-fade-in">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">會員管理與消費統計</h1>
            <p className="text-gray-500 mt-1 text-sm">
              檢視顧客 LINE 檔案、編輯會員姓名、雙軌時數累計（不限時人次 vs 一般計時）及近 2 個月登入紀錄。
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setShowScanModal(true);
                setScanCodeInput('');
                setScanResult(null);
              }}
              className="px-4 py-2.5 bg-[#8B5B43] hover:bg-[#724834] text-white rounded-xl text-sm font-bold flex items-center gap-2 shadow-xs transition-colors shrink-0"
            >
              <QrCode className="w-4 h-4" />
              <span>條碼快速核銷</span>
            </button>
            <div className="relative w-full md:w-72">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Search className="h-4 w-4 text-gray-400" />
              </div>
              <input
                type="text"
                placeholder="搜尋姓名、電話或 LINE 暱稱..."
                value={memberSearchQuery}
                onChange={(e) => {
                  setMemberSearchQuery(e.target.value);
                  setPage(1);
                }}
                className="pl-10 pr-4 py-2.5 border border-[#E8DEC8] bg-white rounded-xl text-sm focus:border-[#8B5B43] w-full transition-shadow outline-none shadow-2xs text-[#3E332B]"
              />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-[#E8DEC8] overflow-hidden">
          <div className="overflow-x-auto">
            {isLoading ? (
              <div className="p-12 text-center text-gray-400">載入中...</div>
            ) : users.length === 0 ? (
              <div className="p-12 text-center text-gray-400 font-medium">找不到符合的會員</div>
            ) : (
              <table className="w-full text-left whitespace-nowrap">
                <thead>
                  <tr className="bg-[#FAF7F2] text-[#8C8279] text-xs uppercase tracking-wider border-b border-[#E8DEC8]">
                    <th className="px-6 py-4 font-semibold">顧客 / LINE 檔案</th>
                    <th className="px-6 py-4 font-semibold">✨ 不限時(封頂)累計</th>
                    <th className="px-6 py-4 font-semibold">⏱️ 一般計時累計</th>
                    <th className="px-6 py-4 font-semibold">💰 累計消費 / 到訪</th>
                    <th className="px-6 py-4 font-semibold">最後登入 / 註冊</th>
                    <th className="px-6 py-4 font-semibold">狀態</th>
                    <th className="px-6 py-4 font-semibold text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {users.map(u => {
                    const stats = u.stats || {
                      unlimited_pax_count: 0,
                      unlimited_orders_count: 0,
                      regular_person_hours: 0,
                      regular_pure_hours: 0,
                      regular_orders_count: 0,
                      completed_visits_count: 0,
                      total_spent: 0,
                      no_show_count: 0
                    };
                    const isManualOnly = u.line_user_id?.startsWith('manual_');

                    return (
                      <tr
                        key={u.id}
                        onClick={() => handleSelectMember(u)}
                        className="hover:bg-[#FAF7F2]/60 transition-colors cursor-pointer"
                      >
                        {/* Customer & LINE Profile */}
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3.5">
                            {u.line_picture_url ? (
                              <img
                                src={u.line_picture_url}
                                alt={u.name || 'avatar'}
                                className="w-10 h-10 rounded-full object-cover border border-gray-200 shrink-0"
                                onError={(e) => { e.currentTarget.style.display = 'none'; }}
                              />
                            ) : (
                              <div className="w-10 h-10 rounded-full bg-[#FAF7F2] text-[#8B5B43] flex items-center justify-center font-bold text-sm border border-[#E8DEC8] shrink-0">
                                {u.name ? u.name.slice(0, 1) : <User className="w-5 h-5" />}
                              </div>
                            )}
                            <div className="flex flex-col">
                              <div className="flex items-center gap-2">
                                <span className={`font-bold text-sm ${u.is_blacklisted ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                                  {u.name || '未設定'}
                                </span>
                                {u.line_display_name && (
                                  <span className="text-xs px-2 py-0.5 rounded-full bg-[#06C755]/10 text-[#059941] font-semibold">
                                    LINE: {u.line_display_name}
                                  </span>
                                )}
                                {isManualOnly && (
                                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">
                                    現場建檔
                                  </span>
                                )}
                              </div>
                              <span className="text-xs text-gray-500 mt-0.5 font-mono">{u.phone || '未提供電話'}</span>
                            </div>
                          </div>
                        </td>

                        {/* Unlimited (Capped) Stats */}
                        <td className="px-6 py-4">
                          {stats.unlimited_pax_count > 0 ? (
                            <div className="flex flex-col">
                              <span className="inline-flex items-center gap-1 font-bold text-amber-700 text-sm">
                                <Sparkles className="w-3.5 h-3.5 text-amber-600" />
                                {stats.unlimited_pax_count} 人次
                              </span>
                              <span className="text-xs text-gray-400">共 {stats.unlimited_orders_count} 筆訂單</span>
                            </div>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </td>

                        {/* Regular Hourly Stats */}
                        <td className="px-6 py-4">
                          {stats.regular_person_hours > 0 ? (
                            <div className="flex flex-col">
                              <span className="inline-flex items-center gap-1 font-bold text-[#8B5B43] text-sm">
                                <Clock className="w-3.5 h-3.5 text-[#8B5B43]" />
                                {stats.regular_person_hours} 小時 <span className="text-xs font-normal text-gray-500">(人時)</span>
                              </span>
                              <span className="text-xs text-gray-400">
                                純時段 {stats.regular_pure_hours}h / {stats.regular_orders_count} 筆
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </td>

                        {/* Total Spent & Visits */}
                        <td className="px-6 py-4">
                          <div className="flex flex-col">
                            <span className="font-bold text-gray-800 text-sm">
                              NT$ {(stats.total_spent || 0).toLocaleString()}
                            </span>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-xs text-gray-500">完訪 {stats.completed_visits_count} 次</span>
                              {stats.no_show_count > 0 && (
                                <span className="inline-flex items-center gap-0.5 text-[11px] font-bold text-red-600 bg-red-50 px-1.5 py-0.5 rounded">
                                  <AlertTriangle className="w-3 h-3" /> 爽約 {stats.no_show_count}
                                </span>
                              )}
                            </div>
                          </div>
                        </td>

                        {/* Last Login / Created At */}
                        <td className="px-6 py-4">
                          <div className="flex flex-col text-xs">
                            {u.last_login_at ? (
                              <span className="text-gray-700 font-medium">
                                登入：{format(new Date(u.last_login_at), 'MM/dd HH:mm')}
                              </span>
                            ) : (
                              <span className="text-gray-400">尚無近期登入</span>
                            )}
                            <span className="text-gray-400 mt-0.5">
                              註冊：{format(new Date(u.created_at), 'yyyy/MM/dd')}
                            </span>
                          </div>
                        </td>

                        {/* Status */}
                        <td className="px-6 py-4">
                          {u.is_blacklisted ? (
                            <span className="inline-flex items-center gap-1 text-red-600 text-xs font-bold bg-red-50 border border-red-200 px-2.5 py-1 rounded-lg">
                              <XCircle className="w-3.5 h-3.5" /> 黑名單
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-emerald-700 text-xs font-medium bg-emerald-50 px-2.5 py-1 rounded-lg">
                              正常
                            </span>
                          )}
                        </td>

                        {/* Actions */}
                        <td className="px-6 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                          {!u.line_user_id?.startsWith('manual_') ? (
                            <button
                              type="button"
                              onClick={() => setLineMessageTargetUser(u)}
                              className="inline-flex items-center gap-1 text-xs font-bold px-3 py-1.5 rounded-lg bg-[#06C755] hover:bg-[#05b34c] text-white shadow-2xs transition active:scale-95"
                              title="發送 LINE 訊息給此會員"
                            >
                              <MessageCircle className="w-3.5 h-3.5 fill-current" />
                              發訊
                            </button>
                          ) : (
                            <span className="text-[11px] text-gray-400 font-medium">未綁定LINE</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          
          {/* Pagination UI */}
          {totalPages > 1 && (
            <div className="p-4 border-t border-gray-100 flex items-center justify-between">
              <p className="text-sm text-gray-500">
                共 {totalRecords} 位會員
              </p>
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1 text-sm bg-gray-50 border rounded hover:bg-gray-100 disabled:opacity-50"
                >
                  上一頁
                </button>
                <span className="text-sm font-medium text-gray-600">
                  {page} / {totalPages}
                </span>
                <button 
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-3 py-1 text-sm bg-gray-50 border rounded hover:bg-gray-100 disabled:opacity-50"
                >
                  下一頁
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <MemberDetailsModal 
        member={selectedMember} 
        onClose={() => handleSelectMember(null)}
        onMemberUpdated={(updatedUser) => {
          setUsers(prev => prev.map(u => u.id === updatedUser.id ? { ...u, ...updatedUser } : u));
          setSelectedMember(prev => prev && prev.id === updatedUser.id ? { ...prev, ...updatedUser } : prev);
        }}
      />

      <SendLineMessageModal
        isOpen={Boolean(lineMessageTargetUser)}
        onClose={() => setLineMessageTargetUser(null)}
        user={lineMessageTargetUser}
      />

      {/* Quick Barcode Scan & Redeem Modal */}
      {showScanModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-[#E8DEC8] space-y-5">
            <div className="flex items-center justify-between border-b border-gray-100 pb-3">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-[#8B5B43]/10 text-[#8B5B43] rounded-xl">
                  <QrCode className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-[#3E332B]">條碼快速核銷卡券</h3>
                  <p className="text-xs text-gray-500">掃描槍或手動輸入顧客卡券條碼</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowScanModal(false)}
                className="p-1.5 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleQuickRedeem} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-[#3E332B] mb-1.5">
                  卡券條碼 / 代碼 (Pass Code) *
                </label>
                <input
                  type="text"
                  autoFocus
                  required
                  value={scanCodeInput}
                  onChange={(e) => setScanCodeInput(e.target.value)}
                  placeholder="點此使用掃描槍刷條碼，或手動輸入"
                  className="w-full px-4 py-3 bg-[#FAF7F2] border-2 border-[#E8DEC8] rounded-xl text-base font-mono font-bold text-[#3E332B] focus:border-[#8B5B43] outline-none shadow-inner"
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  💡 支援門市 USB/藍牙條碼掃描槍，刷碼後會自動帶入並可按 Enter 送出
                </p>
              </div>

              {/* Result banner */}
              {scanResult && (
                <div
                  className={`p-4 rounded-xl border text-xs font-bold flex items-start gap-2.5 ${
                    scanResult.success
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                      : 'bg-rose-50 text-rose-800 border-rose-200'
                  }`}
                >
                  {scanResult.success ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  )}
                  <div className="space-y-1">
                    <div>{scanResult.message}</div>
                    {scanResult.data?.user && (
                      <div className="text-emerald-900 font-normal">
                        持有人：<span className="font-bold">{scanResult.data.user.name || '會員'}</span> ｜ 
                        剩餘額度：<span className="font-bold">{scanResult.data.remaining_quota != null ? `${scanResult.data.remaining_quota} 次` : '暢遊無限制'}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setShowScanModal(false)}
                  className="px-4 py-2 border border-gray-300 text-gray-600 text-sm font-bold rounded-xl hover:bg-gray-50"
                >
                  關閉
                </button>
                <button
                  type="submit"
                  disabled={isRedeemingCode || !scanCodeInput.trim()}
                  className="px-5 py-2 bg-[#8B5B43] hover:bg-[#724834] text-white text-sm font-bold rounded-xl shadow-xs transition-colors disabled:opacity-40"
                >
                  {isRedeemingCode ? '核銷中...' : '確認核銷 1 次'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <style dangerouslySetInnerHTML={{__html: `
        .animate-in { animation: animateIn 0.4s ease-out forwards; }
        @keyframes animateIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      `}} />
    </>
  );
}
