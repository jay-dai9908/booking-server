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
  const [allowUnlimited, setAllowUnlimited] = useState(true);

  // Pricing States
  const [globalWeekdayHourly, setGlobalWeekdayHourly] = useState('');
  const [globalWeekdayUnlimited, setGlobalWeekdayUnlimited] = useState('');
  const [globalWeekendHourly, setGlobalWeekendHourly] = useState('');
  const [globalWeekendUnlimited, setGlobalWeekendUnlimited] = useState('');
  
  const [dailyHourly, setDailyHourly] = useState('');
  const [dailyUnlimited, setDailyUnlimited] = useState('');

  const [batchStartDate, setBatchStartDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [batchEndDate, setBatchEndDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [batchHourly, setBatchHourly] = useState('');
  const [batchUnlimited, setBatchUnlimited] = useState('');
  const [isBatching, setIsBatching] = useState(false);

  useEffect(() => {
    fetchGlobalSetting();
  }, []);

  useEffect(() => {
    fetchSessions(listDate);
    fetchDailySetting(listDate);
  }, [listDate]);

  const fetchGlobalSetting = async () => {
    try {
      const res = await api.get('/daily-settings/global');
      setGlobalWeekdayHourly(res.data.weekday_hourly_price || '');
      setGlobalWeekdayUnlimited(res.data.weekday_unlimited_price || '');
      setGlobalWeekendHourly(res.data.weekend_hourly_price || '');
      setGlobalWeekendUnlimited(res.data.weekend_unlimited_price || '');
    } catch (err) {
      console.error('Error fetching global setting:', err);
    }
  };

  const fetchDailySetting = async (date) => {
    try {
      const res = await api.get(`/daily-settings?date=${date}`);
      setAllowUnlimited(res.data.allow_unlimited);
      setDailyHourly(res.data.hourly_price || '');
      setDailyUnlimited(res.data.unlimited_price || '');
    } catch (err) {
      console.error('Error fetching daily setting:', err);
    }
  };

  const handleToggleUnlimited = async () => {
    const newValue = !allowUnlimited;
    setAllowUnlimited(newValue);
    try {
      await api.put('/daily-settings', { date: listDate, allow_unlimited: newValue });
    } catch (err) {
      console.error('Error updating daily setting:', err);
      setAllowUnlimited(!newValue);
      alert('更新設定失敗');
    }
  };

  const handleUpdateGlobalPrice = async (e) => {
    e.preventDefault();
    try {
      await api.put('/daily-settings/global', { 
        weekday_hourly_price: globalWeekdayHourly || null, 
        weekday_unlimited_price: globalWeekdayUnlimited || null,
        weekend_hourly_price: globalWeekendHourly || null,
        weekend_unlimited_price: globalWeekendUnlimited || null
      });
      alert('全店預設價格更新成功！');
    } catch (err) {
      alert('更新失敗');
    }
  };

  const handleUpdateDailyPrice = async (e) => {
    e.preventDefault();
    try {
      await api.put('/daily-settings', { 
        date: listDate,
        hourly_price: dailyHourly || null,
        unlimited_price: dailyUnlimited || null
      });
      alert('單日覆蓋價格更新成功！');
    } catch (err) {
      alert('更新失敗');
    }
  };

  const handleBatchUpdatePrices = async (e) => {
    e.preventDefault();
    setIsBatching(true);
    try {
      await api.post('/daily-settings/batch', {
        start_date: batchStartDate,
        end_date: batchEndDate,
        hourly_price: batchHourly || null,
        unlimited_price: batchUnlimited || null
      });
      alert('批次修改成功！');
      fetchDailySetting(listDate);
    } catch (err) {
      alert('批次修改失敗');
    } finally {
      setIsBatching(false);
    }
  };

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
          <div className="flex flex-col md:flex-row md:items-center justify-between bg-white p-4 rounded-2xl shadow-sm border border-gray-200 gap-4">
            <h2 className="font-bold text-gray-900">時段列表</h2>
            <div className="flex items-center gap-4">
              <label className="flex items-center cursor-pointer">
                <div className="relative">
                  <input type="checkbox" className="sr-only" checked={allowUnlimited} onChange={handleToggleUnlimited} disabled={isLoading} />
                  <div className={`block w-10 h-6 rounded-full transition-colors ${allowUnlimited ? 'bg-purple-500' : 'bg-gray-300'}`}></div>
                  <div className={`dot absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${allowUnlimited ? 'transform translate-x-4' : ''}`}></div>
                </div>
                <div className="ml-3 text-sm font-medium text-gray-700">開放不限時預約</div>
              </label>
              <div className="h-6 w-px bg-gray-200 hidden md:block"></div>
              <input
                type="date"
                value={listDate}
                onChange={(e) => setListDate(e.target.value)}
                className="px-4 py-2 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none text-sm font-medium text-gray-700"
              />
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

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8 mt-8">
        {/* Global Prices */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200">
          <h2 className="text-lg font-bold text-gray-900 mb-6 flex items-center gap-2">
            預設全店價格
          </h2>
          <form onSubmit={handleUpdateGlobalPrice} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">平日/時</label>
                <input type="number" value={globalWeekdayHourly} onChange={e => setGlobalWeekdayHourly(e.target.value)} placeholder="100" className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"/>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">平日/上限</label>
                <input type="number" value={globalWeekdayUnlimited} onChange={e => setGlobalWeekdayUnlimited(e.target.value)} placeholder="550" className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"/>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">假日/時</label>
                <input type="number" value={globalWeekendHourly} onChange={e => setGlobalWeekendHourly(e.target.value)} placeholder="150" className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"/>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">假日/上限</label>
                <input type="number" value={globalWeekendUnlimited} onChange={e => setGlobalWeekendUnlimited(e.target.value)} placeholder="800" className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"/>
              </div>
            </div>
            <button type="submit" className="w-full bg-gray-900 hover:bg-gray-800 text-white font-medium py-3 rounded-xl transition-all shadow-sm">儲存全店預設</button>
          </form>
        </div>

        {/* Daily Prices Overrides */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200">
          <h2 className="text-lg font-bold text-gray-900 mb-6 flex items-center gap-2">
            {format(new Date(listDate), 'yyyy-MM-dd')} 單日覆蓋設定
          </h2>
          <form onSubmit={handleUpdateDailyPrice} className="space-y-4">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">每小時價格 (留空使用預設)</label>
              <input type="number" value={dailyHourly} onChange={e => setDailyHourly(e.target.value)} placeholder="留空使用預設" className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"/>
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">不限時價格 (留空使用預設)</label>
              <input type="number" value={dailyUnlimited} onChange={e => setDailyUnlimited(e.target.value)} placeholder="留空使用預設" className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"/>
            </div>
            <button type="submit" className="w-full bg-gray-900 hover:bg-gray-800 text-white font-medium py-3 rounded-xl transition-all shadow-sm">儲存單日覆蓋</button>
          </form>
        </div>

        {/* Batch Prices Overrides */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200">
          <h2 className="text-lg font-bold text-gray-900 mb-6 flex items-center gap-2">
            批次修改價格覆蓋
          </h2>
          <form onSubmit={handleBatchUpdatePrices} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">開始日期</label>
                <input type="date" required value={batchStartDate} onChange={e => {setBatchStartDate(e.target.value); if(e.target.value > batchEndDate) setBatchEndDate(e.target.value);}} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"/>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">結束日期</label>
                <input type="date" required min={batchStartDate} value={batchEndDate} onChange={e => setBatchEndDate(e.target.value)} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"/>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">每小時價格</label>
                <input type="number" value={batchHourly} onChange={e => setBatchHourly(e.target.value)} placeholder="留空清除覆蓋" className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"/>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">不限時價格</label>
                <input type="number" value={batchUnlimited} onChange={e => setBatchUnlimited(e.target.value)} placeholder="留空清除覆蓋" className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"/>
              </div>
            </div>
            <button type="submit" disabled={isBatching} className="w-full bg-gray-900 hover:bg-gray-800 text-white font-medium py-3 rounded-xl transition-all shadow-sm disabled:opacity-50">
              {isBatching ? <div className="w-5 h-5 mx-auto border-2 border-white/30 border-t-white rounded-full animate-spin" /> : '批次儲存覆蓋'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
