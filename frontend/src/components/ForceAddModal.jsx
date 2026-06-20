import React, { useState, useEffect } from 'react';
import { User, Phone, Users, X, Clock } from 'lucide-react';
import api from '../api/axios';

export default function ForceAddModal({ isOpen, onClose, selectedSessionId, sessions = [], onSuccess }) {
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    pax: 1
  });
  const [selectedSessions, setSelectedSessions] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Initialize selected sessions with the currently viewed session
  useEffect(() => {
    if (isOpen) {
      if (selectedSessionId) {
        setSelectedSessions([selectedSessionId]);
      } else {
        setSelectedSessions([]);
      }
    }
  }, [isOpen, selectedSessionId]);

  if (!isOpen) return null;

  const toggleSession = (id) => {
    setSelectedSessions(prev => 
      prev.includes(id) ? prev.filter(sid => sid !== id) : [...prev, id]
    );
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.name || formData.pax < 1) {
      setError('請填寫顧客姓名，且人數必須大於 0');
      return;
    }
    if (selectedSessions.length === 0) {
      setError('請至少選擇一個時段');
      return;
    }

    setIsSubmitting(true);
    setError('');

    // Sort sessions chronologically
    const sortedSessionIds = [...selectedSessions].sort((a, b) => {
      const sA = sessions.find(s => s.id === a);
      const sB = sessions.find(s => s.id === b);
      if (!sA || !sB) return 0;
      return sA.start_time.localeCompare(sB.start_time);
    });

    try {
      await api.post('/reservations/admin', {
        session_ids: sortedSessionIds,
        pax: formData.pax,
        name: formData.name,
        phone: formData.phone,
        isForceWait: true
      });
      
      onSuccess(); // triggers refetch
      onClose();
      setFormData({ name: '', phone: '', pax: 1 });
    } catch (err) {
      setError(err.response?.data?.error || '建立失敗，請稍後再試');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[120] p-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden animate-fade-in-up flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="bg-indigo-600 px-6 py-4 flex items-center justify-between shrink-0">
          <h2 className="text-xl font-bold text-white">➕ 現場加人 (外加區)</h2>
          <button 
            onClick={onClose}
            className="text-indigo-200 hover:text-white transition-colors p-1"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 md:p-8 overflow-y-auto">
          <p className="text-sm text-gray-500 mb-6 bg-indigo-50 p-3 rounded-lg border border-indigo-100 text-indigo-700">
            將顧客直接加入目前的「虛擬等候 / 外加區」。
          </p>

          {error && (
            <div className="mb-6 p-4 bg-red-50 text-red-700 text-sm rounded-xl border border-red-100 font-medium">
              {error}
            </div>
          )}

          <div className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">顧客姓名</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400">
                    <User className="w-5 h-5" />
                  </div>
                  <input
                    type="text"
                    required
                    placeholder="例如：王先生"
                    value={formData.name}
                    onChange={(e) => setFormData({...formData, name: e.target.value})}
                    className="w-full pl-11 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-indigo-500 transition-all outline-none"
                  />
                </div>
              </div>

              {/* Phone */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">聯絡電話 <span className="text-gray-400 font-normal">(選填)</span></label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400">
                    <Phone className="w-5 h-5" />
                  </div>
                  <input
                    type="tel"
                    placeholder="例如：0912345678"
                    value={formData.phone}
                    onChange={(e) => setFormData({...formData, phone: e.target.value})}
                    className="w-full pl-11 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-indigo-500 transition-all outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Pax */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">預約人數</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400">
                  <Users className="w-5 h-5" />
                </div>
                <input
                  type="number"
                  min="1"
                  max="20"
                  required
                  value={formData.pax}
                  onChange={(e) => setFormData({...formData, pax: parseInt(e.target.value) || 1})}
                  className="w-full pl-11 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-indigo-500 transition-all outline-none"
                />
              </div>
            </div>

            {/* Multi-Session Selection */}
            <div className="pt-2 border-t border-gray-100">
              <div className="flex items-center justify-between mb-3">
                <label className="block text-sm font-medium text-gray-700">選擇時段 (可複選)</label>
                <span className="text-xs bg-indigo-50 text-indigo-700 px-2 py-1 rounded-md font-medium">
                  已選 {selectedSessions.length} 小時
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {sessions.map(session => {
                  const isSelected = selectedSessions.includes(session.id);
                  return (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => toggleSession(session.id)}
                      className={`py-2.5 px-3 rounded-xl border flex items-center justify-center gap-2 transition-all text-sm font-bold ${
                        isSelected 
                          ? 'border-indigo-600 bg-indigo-600 text-white shadow-md' 
                          : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300 hover:bg-gray-100'
                      }`}
                    >
                      <Clock className="w-4 h-4 opacity-70" />
                      {session.start_time}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="mt-8 flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-3 px-4 bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium rounded-xl transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex-1 py-3 px-4 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-xl transition-colors shadow-lg shadow-indigo-200 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isSubmitting ? (
                <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                '確認新增'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
