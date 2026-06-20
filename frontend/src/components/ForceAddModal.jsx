import React, { useState } from 'react';
import { User, Phone, Users, X } from 'lucide-react';
import api from '../api/axios';

export default function ForceAddModal({ isOpen, onClose, selectedSessionId, onSuccess }) {
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    pax: 1
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.name || !formData.phone || formData.pax < 1) {
      setError('請填寫所有必要資訊，且人數必須大於 0');
      return;
    }

    setIsSubmitting(true);
    setError('');

    try {
      await api.post('/reservations/admin', {
        session_ids: [selectedSessionId],
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
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden animate-fade-in-up">
        {/* Header */}
        <div className="bg-indigo-600 px-6 py-4 flex items-center justify-between">
          <h2 className="text-xl font-bold text-white">➕ 現場加人 (外加區)</h2>
          <button 
            onClick={onClose}
            className="text-indigo-200 hover:text-white transition-colors p-1"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 md:p-8">
          <p className="text-sm text-gray-500 mb-6 bg-indigo-50 p-3 rounded-lg border border-indigo-100 text-indigo-700">
            將顧客直接加入目前的「虛擬等候 / 外加區」。
          </p>

          {error && (
            <div className="mb-6 p-4 bg-red-50 text-red-700 text-sm rounded-xl border border-red-100 font-medium">
              {error}
            </div>
          )}

          <div className="space-y-5">
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
                  className="w-full pl-11 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-indigo-500 transition-all outline-none"
                />
              </div>
            </div>

            {/* Phone */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">聯絡電話</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400">
                  <Phone className="w-5 h-5" />
                </div>
                <input
                  type="tel"
                  required
                  placeholder="例如：0912345678"
                  value={formData.phone}
                  onChange={(e) => setFormData({...formData, phone: e.target.value})}
                  className="w-full pl-11 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-indigo-500 transition-all outline-none"
                />
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
                  className="w-full pl-11 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-indigo-500 transition-all outline-none"
                />
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
