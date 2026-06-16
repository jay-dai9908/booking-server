import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
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
        <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden relative z-10 flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-200">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
            <h2 className="text-xl font-bold text-gray-800">歷史預約紀錄</h2>
            <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-200 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
          
          <div className="p-6 overflow-y-auto flex-1">
            {loading ? (
              <div className="flex justify-center items-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
              </div>
            ) : reservations.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                目前沒有任何預約紀錄。
              </div>
            ) : (
              <div className="space-y-3">
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
                      className="group flex flex-col md:flex-row md:items-center justify-between p-4 rounded-xl border border-gray-100 hover:border-indigo-200 hover:shadow-md bg-white transition-all cursor-pointer gap-4"
                    >
                      <div>
                        <div className="flex items-center gap-3 mb-1">
                          <span className="font-bold text-gray-900">
                            {format(new Date(rFormatted.session_date), 'yyyy/MM/dd')}
                          </span>
                          <span className="text-sm font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded-md tracking-wider">
                            {rFormatted.start_time} - {rFormatted.end_time}
                          </span>
                        </div>
                        <p className="text-sm text-gray-500">
                          {rFormatted.pax} 人
                        </p>
                      </div>
                      <div className="flex items-center justify-between md:justify-end gap-4 w-full md:w-auto">
                        <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium ${statusUI.bgClass} ${statusUI.colorClass}`}>
                          {statusUI.icon} {statusUI.text}
                        </span>
                        <span className="text-indigo-600 text-sm font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                          查看詳情 &rarr;
                        </span>
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
