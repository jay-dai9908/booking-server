import React, { useState, useEffect } from 'react';
import { X, ChevronRight } from 'lucide-react';
import api from '../api/axios';
import { format } from 'date-fns';
import CustomerReservationDetailsModal, { getReservationStatusUI } from './CustomerReservationDetailsModal';

export default function CustomerHistoryModal({ onClose }) {
  const [reservations, setReservations] = useState([]);
  const [loading, setLoading] = useState(true);
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

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-[4px]" onClick={onClose} />
        <div className="bg-[#F9F7F3] rounded-[24px] shadow-[0_20px_40px_rgba(139,91,67,0.1)] w-full max-w-2xl overflow-hidden relative z-10 flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-200">
          <div className="px-6 py-5 border-b border-[#EBE5DF] flex items-center justify-between">
            <h2 className="text-xl font-bold text-[#3E332B]">歷史預約紀錄</h2>
            <button onClick={onClose} className="p-2 text-[#8C8279] hover:text-[#3E332B] rounded-full hover:bg-[#EBE5DF] transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
          
          <div className="p-6 overflow-y-auto flex-1">
            {loading ? (
              <div className="flex justify-center items-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#8B5B43]"></div>
              </div>
            ) : reservations.length === 0 ? (
              <div className="text-center py-12 text-[#8C8279]">
                目前沒有任何預約紀錄。
              </div>
            ) : (
              <div className="space-y-4">
                {reservations.map((r, i) => {
                  const rFormatted = {
                    ...r,
                    start_time: r.start_time || r.session?.start_time,
                    end_time: r.end_time || r.session?.end_time,
                    session_date: r.session_date || r.session?.session_date
                  };
                  const statusUI = getReservationStatusUI(rFormatted);
                  return (
                    <div 
                      key={i}
                      onClick={() => setSelectedReservation(rFormatted)}
                      className="group flex flex-col md:flex-row md:items-center justify-between p-5 rounded-[16px] border border-[#EBE5DF] hover:border-[#D5CFC9] hover:shadow-[0_4px_12px_rgba(139,91,67,0.05)] hover:-translate-y-0.5 bg-white transition-all cursor-pointer gap-4"
                    >
                      <div>
                        <div className="flex flex-wrap items-center gap-3 mb-1.5">
                          <span className="font-bold text-[#3E332B] text-lg">
                            {format(new Date(rFormatted.session_date), 'yyyy/MM/dd')}
                          </span>
                          <span className="text-sm font-medium text-[#8C8279] bg-[#F4EFE6] px-2 py-0.5 rounded-md tracking-wider">
                            {rFormatted.time_blocks 
                              ? rFormatted.time_blocks.map(b => `${b.start_time} - ${b.end_time}`).join(', ')
                              : `${rFormatted.start_time} - ${rFormatted.end_time}`}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-[#8C8279]">
                            {rFormatted.pax} 人
                          </p>
                          {rFormatted.is_unlimited && (
                            <span className="inline-flex items-center gap-1 text-xs font-bold text-[#A67C52] bg-[#F4EFE6] px-2 py-0.5 rounded-full border border-[#D5CFC9]">
                              ✨ 不限時
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between md:justify-end gap-5 w-full md:w-auto">
                        <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium ${statusUI.bgClass} ${statusUI.colorClass}`}>
                          {statusUI.icon} {statusUI.text}
                        </span>
                        <ChevronRight className="w-5 h-5 text-[#8C8279] opacity-50 group-hover:opacity-100 group-hover:text-[#8B5B43] transition-all transform group-hover:translate-x-1" />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {selectedReservation && (
        <CustomerReservationDetailsModal 
          reservation={selectedReservation} 
          onClose={() => setSelectedReservation(null)} 
          onUpdate={fetchReservations}
        />
      )}
    </>
  );
}
