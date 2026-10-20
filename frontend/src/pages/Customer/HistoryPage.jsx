import React, { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, CalendarClock, History, Search, RefreshCw, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/axios';
import { format } from 'date-fns';
import CustomerReservationDetailsModal, { getReservationStatusUI, formatBookingRef } from '../../components/CustomerReservationDetailsModal';
import EquipmentAddonModal from '../../components/EquipmentAddonModal';

export default function HistoryPage() {
  const navigate = useNavigate();
  const [reservations, setReservations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('upcoming'); // 'upcoming' or 'past'
  const [selectedReservation, setSelectedReservation] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');

  const fetchReservations = async () => {
    try {
      const res = await api.get('/reservations/my');
      setReservations(Object.values(res.data));
    } catch (err) {
      console.error('Failed to fetch reservations', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReservations();
  }, []);

  const isPast = (dateStr, timeStr) => {
    if (!timeStr) return true;
    const [hours, minutes] = timeStr.split(':');
    const d = new Date(dateStr);
    d.setHours(parseInt(hours, 10), parseInt(minutes, 10), 0, 0);
    return d < new Date();
  };

  // Format and split reservations
  const formattedReservations = reservations.map(r => ({
    ...r,
    start_time: r.start_time || r.session?.start_time,
    end_time: r.end_time || r.session?.end_time,
    session_date: r.session_date || r.session?.session_date
  }));

  const upcomingReservations = formattedReservations.filter(r => !isPast(r.session_date, r.start_time));
  const pastReservations = formattedReservations.filter(r => isPast(r.session_date, r.start_time));

  const [addonReservation, setAddonReservation] = useState(null);
  const [noticeModal, setNoticeModal] = useState(null);

  const baseList = activeTab === 'upcoming' ? upcomingReservations : pastReservations;

  const displayList = baseList.filter(r => {
    if (!searchTerm.trim()) return true;
    const term = searchTerm.toLowerCase().trim();
    const shortRef = formatBookingRef(r.booking_ref).toLowerCase();
    const fullRef = (r.booking_ref || '').toLowerCase();
    const dateStr = format(new Date(r.session_date), 'yyyy/MM/dd yyyy-MM-dd').toLowerCase();
    const nameStr = (r.user?.name || '').toLowerCase();
    return shortRef.includes(term) || fullRef.includes(term) || dateStr.includes(term) || nameStr.includes(term);
  });

  return (
    <div className="min-h-screen bg-[#F7F4F0] flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-[#F7F4F0]/90 backdrop-blur-md border-b border-[#EBE5DF]">
        <div className="flex items-center justify-between px-4 h-16 max-w-3xl mx-auto w-full relative">
          <button 
            onClick={() => navigate('/booking')} 
            className="flex items-center text-[#8C8279] hover:text-[#3E332B] font-medium transition-colors z-10"
          >
            <ChevronLeft className="w-5 h-5 mr-1" />返回
          </button>
          <h1 className="text-lg font-bold text-[#3E332B] absolute inset-0 flex items-center justify-center pointer-events-none">
            我的預約紀錄
          </h1>
        </div>
      </header>

      {/* Tabs */}
      <div className="px-4 pt-6 pb-3 max-w-3xl mx-auto w-full">
        <div className="flex bg-[#EBE5DF] p-1 rounded-full relative">
          <button
            onClick={() => setActiveTab('upcoming')}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-bold rounded-full transition-all duration-300 z-10 ${
              activeTab === 'upcoming' ? 'bg-white text-[#8B5B43] shadow-sm' : 'text-[#8C8279] hover:text-[#3E332B]'
            }`}
          >
            <CalendarClock className="w-4 h-4" /> 即將到來
          </button>
          <button
            onClick={() => setActiveTab('past')}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-bold rounded-full transition-all duration-300 z-10 ${
              activeTab === 'past' ? 'bg-white text-[#8B5B43] shadow-sm' : 'text-[#8C8279] hover:text-[#3E332B]'
            }`}
          >
            <History className="w-4 h-4" /> 歷史紀錄
          </button>
        </div>
      </div>

      {/* Search Bar & Refresh */}
      <div className="px-4 pb-3 max-w-3xl mx-auto w-full flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="🔍 篩選我的預約 (代碼 BK-XXXX、日期)..."
            className="w-full pl-9 pr-8 py-2.5 bg-white border border-[#E5DFD7] rounded-xl text-xs sm:text-sm text-[#2C241E] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#8B5B43]/30 shadow-sm"
          />
          {searchTerm && (
            <button
              onClick={() => setSearchTerm('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
            >
              ✕
            </button>
          )}
        </div>
        <button
          onClick={() => { setLoading(true); fetchReservations(); }}
          disabled={loading}
          className="p-2.5 bg-white border border-[#E5DFD7] hover:bg-[#F9F7F3] rounded-xl text-[#8B5B43] transition-colors flex items-center justify-center shrink-0 shadow-sm"
          title="重新整理"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* List */}
      <main className="flex-1 px-4 pb-8 max-w-3xl mx-auto w-full">
        {loading ? (
          <div className="flex justify-center items-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#8B5B43]"></div>
          </div>
        ) : displayList.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center px-4">
            <div className="w-16 h-16 bg-[#F4EFE6] rounded-full flex items-center justify-center mb-4">
              {activeTab === 'upcoming' ? (
                <CalendarClock className="w-8 h-8 text-[#A8A19A]" />
              ) : (
                <History className="w-8 h-8 text-[#A8A19A]" />
              )}
            </div>
            <p className="text-[#8C8279] text-base mb-6 font-medium whitespace-pre-line">
              {searchTerm 
                ? "查無符合篩選條件的預約紀錄\n請嘗試更換關鍵字！"
                : (activeTab === 'upcoming' 
                    ? "目前沒有即將到來的預約喔\n快來安排一場手作時光吧！" 
                    : "目前還沒有歷史預約紀錄喔！")}
            </p>
            {searchTerm ? (
              <button 
                onClick={() => setSearchTerm('')}
                className="bg-white border border-[#D5CFC9] text-[#8B5B43] hover:bg-[#FAF7F2] px-6 py-2.5 rounded-full font-bold shadow-sm transition-colors text-sm"
              >
                清除搜尋條件
              </button>
            ) : activeTab === 'upcoming' && (
              <button 
                onClick={() => navigate('/booking')}
                className="bg-[#8B5B43] text-white px-8 py-3 rounded-full font-bold shadow-sm hover:bg-[#A67C52] transition-colors"
              >
                立即預約
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {displayList.sort((a, b) => new Date(b.session_date) - new Date(a.session_date)).map((r, i) => {
              const statusUI = getReservationStatusUI(r);

              // 4-Tier foolproof calculation
              const now = new Date();
              const isCancelled = r.status === 'cancelled';
              const sessionCount = r.session_count || (r.sessions ? r.sessions.length : 1);

              const [endH, endM] = (r.end_time || '00:00').split(':').map(Number);
              const bookingEndTime = new Date(r.session_date);
              bookingEndTime.setHours(endH, endM, 0, 0);

              const [startH, startM] = (r.start_time || '00:00').split(':').map(Number);
              const bookingStartTime = new Date(r.session_date);
              bookingStartTime.setHours(startH, startM, 0, 0);

              const isExpired = now >= bookingEndTime;
              const effectiveStart = new Date(Math.max(now.getTime(), bookingStartTime.getTime()));
              const remainingMinutes = (bookingEndTime.getTime() - effectiveStart.getTime()) / (60 * 1000);

              const totalBoards = (r.equipments || []).reduce((sum, e) => sum + e.quantity, 0);
              const remainingPax = Math.max(0, r.pax - totalBoards);

              // Equipment breakdown label
              let equipmentLabel = '未加購 (全員使用免費一般板)';
              if (r.equipments && r.equipments.length > 0) {
                const parts = r.equipments.map(e => `${e.equipment_name_snapshot} ×${e.quantity}`);
                equipmentLabel = `${parts.join('、')} (${r.equipments[0].rental_hours}hr)${remainingPax > 0 ? ` ｜ 尚有 ${remainingPax} 人可追加` : ''}`;
              }

              return (
                <div 
                  key={i}
                  onClick={() => setSelectedReservation(r)}
                  className="group flex flex-col bg-white p-5 rounded-[16px] border border-transparent hover:border-[#EBE5DF] shadow-[0_4px_12px_rgba(139,91,67,0.05)] transition-all cursor-pointer space-y-3"
                >
                  <div className="flex justify-between items-start gap-2">
                    <div>
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="font-bold text-[#3E332B] text-lg">
                          {format(new Date(r.session_date), 'yyyy/MM/dd')}
                        </span>
                        <span className="font-mono text-xs font-bold text-[#8B5B43] bg-[#F4EFE6] px-2 py-0.5 rounded-md border border-[#E8DEC8]">
                          #{formatBookingRef(r.booking_ref)}
                        </span>
                      </div>
                      <span className="text-sm font-medium text-[#8C8279] bg-[#F4EFE6] px-2.5 py-1 rounded-md inline-block">
                        {r.time_blocks 
                          ? r.time_blocks.map(b => `${b.start_time} - ${b.end_time}`).join(', ')
                          : `${r.start_time} - ${r.end_time}`}
                      </span>
                    </div>
                    <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold shrink-0 ${statusUI.bgClass} ${statusUI.colorClass}`}>
                      {statusUI.icon} {statusUI.text}
                    </span>
                  </div>

                  {/* Smart Pegboard Info Bar */}
                  <div className="bg-[#FAF7F2] rounded-xl p-3 border border-[#E8DEC8]/60 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-[#4A3F35] shrink-0">⚙️ 智能拼豆板：</span>
                      {totalBoards > 0 ? (
                        <span className="bg-[#EDE6DD] text-[#4A3F35] font-bold px-2.5 py-1 rounded-lg">
                          {equipmentLabel}
                        </span>
                      ) : (
                        <span className="text-[#8C8279]">
                          {equipmentLabel}
                        </span>
                      )}
                    </div>

                    {/* Foolproof Action Buttons */}
                    {!isCancelled && !isExpired && (
                      <div className="self-end sm:self-auto shrink-0">
                        {remainingMinutes < 120 ? (
                          /* State C: Less than 2 hours remaining */
                          <div className="flex flex-col items-end">
                            <button
                              disabled
                              className="bg-gray-100 text-gray-400 text-xs px-3 py-1.5 rounded-full font-bold cursor-not-allowed border border-gray-200"
                            >
                              ⏰ 剩餘時數不足 2hr (無法補約智能板)
                            </button>
                            <span className="text-[10px] text-[#A8A19A] mt-1 text-right max-w-[240px]">
                              💡 距離離場已不足2小時，線上已關閉補約，如需借用請洽店員
                            </span>
                          </div>
                        ) : sessionCount < 2 ? (
                          /* State B: Less than 2 hours booking */
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setNoticeModal({
                                title: '時段條件未滿足',
                                message: '⚠️ 租用智能拼豆板需至少連續 2 小時（目前您的訂單僅 1 小時）。現場如有需要可洽門市人員為您協助。'
                              });
                            }}
                            className="bg-[#FAF7F2] border border-[#D5CFC9] text-[#8B5B43] hover:bg-[#F4EFE6] text-xs px-3 py-1.5 rounded-full font-bold transition-colors"
                          >
                            ➕ 補預約智能板 (需滿2小時)
                          </button>
                        ) : (
                          /* State A: Normal add-on / modify */
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setAddonReservation(r);
                            }}
                            className="bg-[#8B5B43] hover:bg-[#724a35] text-white text-xs px-3.5 py-1.5 rounded-full font-bold shadow-sm transition-colors flex items-center gap-1"
                          >
                            {totalBoards > 0 ? '✏️ 追加/修改智能板' : '➕ 補預約智能板'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  
                  <div className="flex items-center justify-between border-t border-[#F4EFE6] pt-3 mt-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-bold text-[#8C8279]">
                        {r.pax} 人
                      </p>
                      {r.is_unlimited && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#A67C52] bg-[#F4EFE6] px-2 py-0.5 rounded-full border border-[#D5CFC9]">
                          ✨ 不限時
                        </span>
                      )}
                      {r.total_amount != null && (
                        <span className="text-sm font-bold text-[#3E332B] ml-2">
                          總額 NT$ {r.total_amount}
                        </span>
                      )}
                    </div>
                    <ChevronRight className="w-5 h-5 text-[#8C8279] opacity-70 group-hover:opacity-100 group-hover:text-[#8B5B43] transition-all transform group-hover:translate-x-1" />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Notice Alert Modal */}
      {noticeModal && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setNoticeModal(null)} />
          <div className="bg-white rounded-[24px] shadow-xl w-full max-w-sm overflow-hidden relative z-10 p-6 text-center space-y-4 animate-in zoom-in-95 duration-200">
            <div className="w-12 h-12 bg-amber-100 text-amber-800 rounded-full flex items-center justify-center mx-auto text-2xl">
              ⚠️
            </div>
            <h3 className="text-lg font-bold text-[#3E332B]">{noticeModal.title}</h3>
            <p className="text-sm text-[#7A7067] leading-relaxed">{noticeModal.message}</p>
            <div className="flex items-center gap-2 pt-2">
              <button
                onClick={() => setNoticeModal(null)}
                className="flex-1 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-full font-bold text-sm transition-colors"
              >
                我知道了
              </button>
              <button
                onClick={() => { setNoticeModal(null); navigate('/booking'); }}
                className="flex-1 py-2.5 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-full font-bold text-sm transition-colors shadow-sm"
              >
                前往新預約
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Equipment Retroactive Add-on Modal */}
      {addonReservation && (
        <EquipmentAddonModal
          reservation={addonReservation}
          isOpen={!!addonReservation}
          onClose={() => setAddonReservation(null)}
          onSuccess={() => {
            fetchReservations();
          }}
        />
      )}

      {/* Detail Modal */}
      {selectedReservation && (
        <CustomerReservationDetailsModal 
          reservation={selectedReservation} 
          onClose={() => setSelectedReservation(null)} 
          onUpdate={fetchReservations}
          onOpenEquipmentAddon={() => {
            const target = selectedReservation;
            setSelectedReservation(null);
            setAddonReservation(target);
          }}
        />
      )}
    </div>
  );
}
