import React, { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { CheckCircle2, XCircle } from 'lucide-react';
import api from '../../api/axios';
import AdminSeatingChart from '../../components/AdminSeatingChart';
import ReservationDetailsModal from '../../components/ReservationDetailsModal';

export default function SeatingPage() {
  const [reservations, setReservations] = useState([]);
  const [selectedReservation, setSelectedReservation] = useState(null);

  useEffect(() => {
    fetchReservations();
  }, []);

  const fetchReservations = async () => {
    try {
      const res = await api.get('/reservations/admin');
      setReservations(res.data);
    } catch (err) {
      console.error(err);
    }
  };

  const handleUpdateAttendance = async (booking_ref, attendance) => {
    try {
      await api.patch(`/reservations/${booking_ref}/attendance`, { attendance });
      setReservations(prev => prev.map(r => 
        r.booking_ref === booking_ref ? { ...r, attendance } : r
      ));
      if (selectedReservation && selectedReservation.booking_ref === booking_ref) {
        setSelectedReservation(prev => ({ ...prev, attendance }));
      }
    } catch (err) {
      console.error(err);
      alert('更新狀態失敗');
    }
  };

  const handleCancelReservation = async (id) => {
    try {
      await api.delete(`/reservations/${id}`);
      fetchReservations();
    } catch (err) {
      alert(err.response?.data?.error || '取消失敗');
    }
  };

  const handleDeleteReservationRecord = async (id) => {
    if (window.confirm('確定要永久刪除此筆訂單紀錄嗎？此操作無法復原。')) {
      try {
        await api.delete(`/reservations/${id}/record`);
        fetchReservations();
        setSelectedReservation(null);
      } catch (err) {
        alert(err.response?.data?.error || '刪除失敗');
      }
    }
  };

  // getReservationStatusUI is handled by ReservationDetailsModal internally for details
  // AdminSeatingChart might not need it, or if it does, it's not in this file

  return (
    <>
      <div className="h-full relative">
        <AdminSeatingChart 
        onOpenDetails={(booking_ref) => {
          const res = reservations.find(r => r.booking_ref === booking_ref);
          if (res) setSelectedReservation(res);
        }}
        onCheckIn={(booking_ref) => handleUpdateAttendance(booking_ref, 'checked_in')}
      />

      </div>

      {/* Reservation Details Modal */}
      <ReservationDetailsModal 
        reservation={selectedReservation} 
        onClose={() => setSelectedReservation(null)} 
        onUpdate={(updates) => {
          if (updates) {
            setSelectedReservation(prev => ({ ...prev, ...updates }));
          } else {
            setSelectedReservation(null);
          }
          fetchReservations();
        }} 
      />

      <style dangerouslySetInnerHTML={{__html: `
        .animate-in { animation: animateIn 0.4s ease-out forwards; }
        @keyframes animateIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      `}} />
    </>
  );
}
