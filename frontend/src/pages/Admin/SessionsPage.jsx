import React, { useState, useEffect } from 'react';
import { format, addDays } from 'date-fns';
import { Plus, Trash2, Clock, CheckCircle2, XCircle } from 'lucide-react';
import api from '../../api/axios';

export default function SessionsPage() {
  const [sessionStartDate, setSessionStartDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [sessionEndDate, setSessionEndDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [listDate, setListDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [startTime, setStartTime] = useState('10:00');
  const [endTime, setEndTime] = useState('11:00');
  const [maxCapacity, setMaxCapacity] = useState(5);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    fetchSessions(listDate);
  }, [listDate]);

  const fetchSessions = async (date = listDate) => {
    setIsLoading(true);
    try {
      const res = await api.get(`/sessions?date=${date}`);
      setSessions(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateSession = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const dates = [];
      let current = new Date(sessionStartDate);
      const end = new Date(sessionEndDate);
      while (current <= end) {
        dates.push(format(current, 'yyyy-MM-dd'));
        current = addDays(current, 1);
      }

      await api.post('/sessions', {
        session_dates: dates,
        start_time: startTime,
        end_time: endTime,
        max_capacity: maxCapacity
      });
      setTimeout(() => {
        alert(`時段新增成功！共新增 ${dates.length} 天`);
        setListDate(sessionStartDate);
        fetchSessions(sessionStartDate);
        setIsSubmitting(false);
      }, 300);
    } catch (err) {
      alert(err.response?.data?.error || '新增失敗');
      setIsSubmitting(false);
    }
  };

  const handleDeleteSession = async (id) => {
    if (window.confirm('確定要刪除此時段嗎？')) {
      try {
        await api.delete(`/sessions/${id}`);
        fetchSessions(listDate);
      } catch (err) {
        alert(err.response?.data?.error || '刪除失敗');
      }
    }
  };

  return (
    <div className="p-4 md:p-8 space-y-8 animate-fade-in">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">營業時段設定</h1>
          <p className="text-gray-500 mt-1 text-sm">設定可供顧客預約的日期與時段。</p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
        {/* Create Session Form */}
        <div className="xl:col-span-1">
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200 sticky top-8">
            <h2 className="text-lg font-bold text-gray-900 mb-6 flex items-center gap-2">
              <Plus className="w-5 h-5 text-gray-500" />
              新增時段
            </h2>
            <form onSubmit={handleCreateSession} className="space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1.5">開始日期</label>
                  <input
                    type="date"
                    required
                    value={sessionStartDate}
                    onChange={(e) => {
                      setSessionStartDate(e.target.value);
                      if (e.target.value > sessionEndDate) setSessionEndDate(e.target.value);
                    }}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1.5">結束日期</label>
                  <input
                    type="date"
                    required
                    value={sessionEndDate}
                    onChange={(e) => setSessionEndDate(e.target.value)}
                    min={sessionStartDate}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1.5 flex items-center gap-1.5">
                    <Clock className="w-4 h-4 text-gray-400"/>
                    開始時間
                  </label>
                  <input
                    type="time"
                    required
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1.5 flex items-center gap-1.5">
                    <Clock className="w-4 h-4 text-gray-400"/>
                    結束時間
                  </label>
                  <input
                    type="time"
                    required
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">容納人數</label>
                <input
                  type="number"
                  min="1"
                  required
                  value={maxCapacity}
                  onChange={(e) => setMaxCapacity(e.target.value)}
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full bg-gray-900 hover:bg-gray-800 text-white font-medium py-3 rounded-xl transition-all shadow-sm disabled:opacity-50 mt-4 flex justify-center"
              >
                {isSubmitting ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : '確認新增'}
              </button>
            </form>
          </div>
        </div>

        {/* Session List */}
        <div className="xl:col-span-2 space-y-4">
          <div className="flex items-center justify-between bg-white p-4 rounded-2xl shadow-sm border border-gray-200">
            <h2 className="font-bold text-gray-900">時段列表</h2>
            <input
              type="date"
              value={listDate}
              onChange={(e) => setListDate(e.target.value)}
              className="px-4 py-2 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none text-sm font-medium text-gray-700"
            />
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              {isLoading ? (
                <div className="p-10 flex justify-center"><div className="w-8 h-8 border-4 border-gray-200 border-t-gray-800 rounded-full animate-spin" /></div>
              ) : (
                <table className="w-full text-left whitespace-nowrap">
                  <thead>
                    <tr className="bg-gray-50 text-gray-500 text-sm border-b border-gray-200">
                      <th className="px-6 py-4 font-medium">時段</th>
                      <th className="px-6 py-4 font-medium">總座位</th>
                      <th className="px-6 py-4 font-medium">剩餘座位</th>
                      <th className="px-6 py-4 font-medium">狀態</th>
                      <th className="px-6 py-4 font-medium text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {sessions.length === 0 ? (
                      <tr><td colSpan="5" className="text-center py-16 text-gray-400">此日期尚無任何時段</td></tr>
                    ) : (
                      sessions.map(s => {
                        const isFull = s.remaining_capacity === 0;
                        return (
                          <tr key={s.id} className="hover:bg-gray-50 transition-colors group">
                            <td className="px-6 py-4 font-semibold text-gray-800">{s.start_time} - {s.end_time}</td>
                            <td className="px-6 py-4 text-gray-500">{s.max_capacity} 人</td>
                            <td className="px-6 py-4">
                              <span className={`font-bold ${isFull ? 'text-gray-300' : 'text-gray-900'}`}>
                                {s.remaining_capacity}
                              </span>
                            </td>
                            <td className="px-6 py-4">
                              {isFull ? 
                                <span className="inline-flex items-center gap-1.5 text-gray-400 text-sm"><XCircle className="w-4 h-4"/>已額滿</span> : 
                                <span className="inline-flex items-center gap-1.5 text-gray-900 text-sm font-medium"><CheckCircle2 className="w-4 h-4"/>開放中</span>}
                            </td>
                            <td className="px-6 py-4 text-right">
                              <button 
                                onClick={() => handleDeleteSession(s.id)}
                                className="text-gray-400 hover:text-red-500 hover:bg-red-50 p-2 rounded-lg transition-colors"
                                title="刪除時段"
                              >
                                <Trash2 className="w-5 h-5" />
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
