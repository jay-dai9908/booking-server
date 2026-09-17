import React, { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, CalendarClock, History } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/axios';
import { format } from 'date-fns';
import CustomerReservationDetailsModal, { getReservationStatusUI } from '../../components/CustomerReservationDetailsModal';

export default function HistoryPage() {
  const navigate = useNavigate();
  const [reservations, setReservations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('upcoming'); // 'upcoming' or 'past'
  const [selectedReservation, setSelectedReservation] = useState(null);

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

  const displayList = activeTab === 'upcoming' ? upcomingReservations : pastReservations;

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
      <div className="px-4 pt-6 pb-4 max-w-3xl mx-auto w-full">
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
              {activeTab === 'upcoming' 
                ? "目前沒有即將到來的預約喔\n快來安排一場手作時光吧！" 
                : "目前還沒有歷史預約紀錄喔！"}
            </p>
            {activeTab === 'upcoming' && (
              <button 
                onClick={() => navigate('/booking')}
                className="bg-[#8B5B43] text-white px-8 py-3 rounded-full font-bold shadow-sm hover:bg-[#A67C52] transition-colors"
              >
                立即預約
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {displayList.sort((a, b) => new Date(b.session_date) - new Date(a.session_date)).map((r, i) => {
              const statusUI = getReservationStatusUI(r);
              return (
                <div 
                  key={i}
                  onClick={() => setSelectedReservation(r)}
                  className="group flex flex-col bg-white p-5 rounded-[16px] border border-transparent hover:border-[#EBE5DF] shadow-[0_4px_12px_rgba(139,91,67,0.05)] transition-all cursor-pointer"
                >
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <span className="font-bold text-[#3E332B] text-lg block mb-1.5">
                        {format(new Date(r.session_date), 'yyyy/MM/dd')}
                      </span>
                      <span className="text-sm font-medium text-[#8C8279] bg-[#F4EFE6] px-2.5 py-1 rounded-md inline-block">
                        {r.time_blocks 
                          ? r.time_blocks.map(b => `${b.start_time} - ${b.end_time}`).join(', ')
                          : `${r.start_time} - ${r.end_time}`}
                      </span>
                    </div>
                    <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold ${statusUI.bgClass} ${statusUI.colorClass}`}>
                      {statusUI.icon} {statusUI.text}
                    </span>
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
                    </div>
                    <ChevronRight className="w-5 h-5 text-[#8C8279] opacity-70 group-hover:opacity-100 group-hover:text-[#8B5B43] transition-all transform group-hover:translate-x-1" />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Detail Modal */}
      {selectedReservation && (
        <CustomerReservationDetailsModal 
          reservation={selectedReservation} 
          onClose={() => setSelectedReservation(null)} 
          onUpdate={fetchReservations}
        />
      )}
    </div>
  );
}
