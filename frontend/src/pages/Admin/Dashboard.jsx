import React, { useState, useEffect } from 'react';
import { format, addDays } from 'date-fns';
import { LayoutDashboard, CalendarRange, Users, LogOut, Plus, Trash2, Clock, CheckCircle2, XCircle, Menu, Search, UserCog, X, CalendarDays, ChevronLeft, ChevronRight, Grid } from 'lucide-react';
import api from '../../api/axios';
import AdminSeatingChart from '../../components/AdminSeatingChart';

function AdminDashboard() {
  const [activeTab, setActiveTab] = useState('sessions'); // 'sessions' | 'reservations' | 'members' | 'weekly' | 'seating'
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  
  // Session Form State
  const [sessionStartDate, setSessionStartDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [sessionEndDate, setSessionEndDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [listDate, setListDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [startTime, setStartTime] = useState('10:00');
  const [endTime, setEndTime] = useState('11:00');
  const [maxCapacity, setMaxCapacity] = useState(5);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  // Data State
  const [sessions, setSessions] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [selectedReservation, setSelectedReservation] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Member Management State
  const [users, setUsers] = useState([]);
  const [memberSearchQuery, setMemberSearchQuery] = useState('');
  const [selectedMember, setSelectedMember] = useState(null);
  const [memberReservations, setMemberReservations] = useState([]);
  const [isMemberLoading, setIsMemberLoading] = useState(false);
  const [isSavingNotes, setIsSavingNotes] = useState(false);

  // Manual Booking State
  const [showManualBooking, setShowManualBooking] = useState(false);
  const [manualDate, setManualDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [manualSessions, setManualSessions] = useState([]);
  const [manualSelectedSessions, setManualSelectedSessions] = useState([]);
  const [manualName, setManualName] = useState('');
  const [manualPhone, setManualPhone] = useState('');
  const [manualPax, setManualPax] = useState(1);
  const [isManualLoading, setIsManualLoading] = useState(false);

  // Weekly Overview State
  const [weeklyStartDate, setWeeklyStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - d.getDay()); // Sunday
    return format(d, 'yyyy-MM-dd');
  });
  const [weeklySessions, setWeeklySessions] = useState([]);
  const [isWeeklyLoading, setIsWeeklyLoading] = useState(false);

  useEffect(() => {
    if (activeTab === 'sessions') {
      fetchSessions(listDate);
    } else if (activeTab === 'reservations') {
      fetchReservations();
    } else if (activeTab === 'members') {
      fetchUsers();
    } else if (activeTab === 'weekly') {
      fetchWeeklySessions();
    }
  }, [activeTab, listDate, weeklyStartDate]);

  useEffect(() => {
    if (showManualBooking) {
      fetchManualSessions();
    }
  }, [manualDate, showManualBooking]);

  const fetchManualSessions = async () => {
    setIsManualLoading(true);
    try {
      const res = await api.get(`/sessions?date=${manualDate}`);
      setManualSessions(res.data);
      setManualSelectedSessions([]); // reset when date changes
    } catch (err) {
      console.error(err);
    } finally {
      setIsManualLoading(false);
    }
  };

  const fetchWeeklySessions = async () => {
    setIsWeeklyLoading(true);
    try {
      const endD = new Date(weeklyStartDate);
      endD.setDate(endD.getDate() + 6);
      const res = await api.get(`/sessions?start_date=${weeklyStartDate}&end_date=${format(endD, 'yyyy-MM-dd')}`);
      setWeeklySessions(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setIsWeeklyLoading(false);
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

  const fetchReservations = async () => {
    setIsLoading(true);
    try {
      const res = await api.get('/reservations/admin');
      setReservations(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateAttendance = async (booking_ref, attendance) => {
    try {
      await api.patch(`/reservations/${booking_ref}/attendance`, { attendance });
      // Update local state for reservations
      setReservations(prev => prev.map(r => 
        r.booking_ref === booking_ref ? { ...r, attendance } : r
      ));
      // Update selected reservation if open
      if (selectedReservation && selectedReservation.booking_ref === booking_ref) {
        setSelectedReservation(prev => ({ ...prev, attendance }));
      }
      // Also update memberReservations if we are in members tab and one is selected
      if (memberReservations.length > 0) {
        setMemberReservations(prev => prev.map(r => 
          r.booking_ref === booking_ref ? { ...r, attendance } : r
        ));
      }
    } catch (err) {
      console.error(err);
      alert('更新狀態失敗');
    }
  };

  const getReservationStatusUI = (r) => {
    if (r.status === 'cancelled') {
      return { text: '已取消', icon: <XCircle className="w-4 h-4"/>, colorClass: 'text-gray-400', bgClass: 'bg-gray-100' };
    }
    if (r.attendance === 'checked_in') {
      return { text: '已報到', icon: <CheckCircle2 className="w-4 h-4"/>, colorClass: 'text-blue-600', bgClass: 'bg-blue-50' };
    }
    if (r.attendance === 'no_show') {
      return { text: '預約未到', icon: <XCircle className="w-4 h-4"/>, colorClass: 'text-red-500', bgClass: 'bg-red-50' };
    }

    // Dynamic fallback for no-show
    const now = new Date();
    // Start time comes in format "HH:mm". We need to construct a proper date object.
    const [hours, minutes] = r.start_time.split(':').map(Number);
    const sessionDate = new Date(r.session_date);
    sessionDate.setHours(hours, minutes, 0, 0);
    
    // Add 15 mins
    sessionDate.setMinutes(sessionDate.getMinutes() + 15);

    if (now > sessionDate) {
      return { text: '預約未到', icon: <XCircle className="w-4 h-4"/>, colorClass: 'text-red-500', bgClass: 'bg-red-50' };
    }

    return { text: '預約成功', icon: <CheckCircle2 className="w-4 h-4"/>, colorClass: 'text-green-600', bgClass: 'bg-green-50' };
  };

  const fetchUsers = async () => {
    setIsLoading(true);
    try {
      const res = await api.get('/users');
      setUsers(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectMember = async (user) => {
    setSelectedMember(user);
    setIsMemberLoading(true);
    try {
      const res = await api.get(`/users/${user.id}/reservations`);
      setMemberReservations(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setIsMemberLoading(false);
    }
  };

  const handleUpdateMember = async (id, data) => {
    setIsSavingNotes(true);
    try {
      const res = await api.put(`/users/${id}`, data);
      setUsers(users.map(u => u.id === id ? res.data.user : u));
      setSelectedMember(res.data.user);
    } catch (err) {
      console.error(err);
      alert('更新失敗');
    } finally {
      setIsSavingNotes(false);
    }
  };

  const toggleManualSession = (session) => {
    if (session.remaining_capacity === 0) return;
    setManualSelectedSessions(prev => {
      const isSelected = prev.find(s => s.id === session.id);
      if (isSelected) {
        return prev.filter(s => s.id !== session.id);
      } else {
        return [...prev, session];
      }
    });
  };

  const manualMaxPax = manualSelectedSessions.length > 0 
    ? Math.min(...manualSelectedSessions.map(s => s.remaining_capacity))
    : 0;

  useEffect(() => {
    if (manualSelectedSessions.length > 0 && manualPax > manualMaxPax) {
      setManualPax(manualMaxPax > 0 ? manualMaxPax : 1);
    }
  }, [manualSelectedSessions, manualMaxPax, manualPax]);

  const handleManualSubmit = async (e) => {
    e.preventDefault();
    if (manualSelectedSessions.length === 0) {
      alert('請至少選擇一個時段');
      return;
    }
    const sortedSessions = [...manualSelectedSessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
    
    try {
      await api.post('/reservations/admin', {
        name: manualName,
        phone: manualPhone,
        session_ids: sortedSessions.map(s => s.id),
        pax: manualPax
      });
      alert('手動預約建立成功！');
      setShowManualBooking(false);
      setManualName('');
      setManualPhone('');
      setManualSelectedSessions([]);
      fetchReservations();
    } catch (err) {
      alert(err.response?.data?.error || '手動預約失敗');
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

  const handleClearDay = async () => {
    if (window.confirm(`確定要清除 ${listDate} 的所有時段嗎？（已有「有效預約」的時段將自動保留，已取消的空時段將一併清除）`)) {
      try {
        const res = await api.delete(`/sessions/date/${listDate}`);
        alert(`清除成功！已刪除 ${res.data.deletedCount} 個空時段，保留 ${res.data.keptCount} 個已預約時段。`);
        fetchSessions(listDate);
      } catch (err) {
        alert(err.response?.data?.error || '清除失敗');
      }
    }
  };

  const handleCancelReservation = async (id) => {
    if (window.confirm('確定要取消此筆預約嗎？')) {
      try {
        await api.delete(`/reservations/${id}`);
        fetchReservations();
      } catch (err) {
        alert(err.response?.data?.error || '取消失敗');
      }
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

  const handleLogout = () => {
    api.post('/auth/logout').then(() => window.location.href = '/admin');
  };

  const SidebarContent = () => (
    <>
      <div className="p-6 flex items-center gap-3 border-b border-gray-100">
        <div className="bg-gray-100 p-2 rounded-xl">
          <LayoutDashboard className="w-6 h-6 text-gray-800" />
        </div>
        <h2 className="text-xl font-bold tracking-wide text-gray-800">後台管理</h2>
      </div>
      <nav className="flex-1 px-4 py-6 space-y-2">
        <button 
          onClick={() => { setActiveTab('sessions'); setIsSidebarOpen(false); }}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 ${
            activeTab === 'sessions' 
              ? 'bg-gray-100 text-gray-900 font-semibold' 
              : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
          }`}
        >
          <CalendarRange className="w-5 h-5" />
          營業時段設定
        </button>
        <button 
          onClick={() => { setActiveTab('reservations'); setIsSidebarOpen(false); }}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 ${
            activeTab === 'reservations' 
              ? 'bg-gray-100 text-gray-900 font-semibold' 
              : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
          }`}
        >
          <Users className="w-5 h-5" />
          預約訂單總覽
        </button>
        <button 
          onClick={() => { setActiveTab('members'); setIsSidebarOpen(false); }}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 ${
            activeTab === 'members' 
              ? 'bg-gray-100 text-gray-900 font-semibold' 
              : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
          }`}
        >
          <UserCog className="w-5 h-5" />
          會員管理
        </button>
        <button 
          onClick={() => { setActiveTab('weekly'); setIsSidebarOpen(false); }}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 ${
            activeTab === 'weekly' 
              ? 'bg-gray-100 text-gray-900 font-semibold' 
              : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
          }`}
        >
          <CalendarDays className="w-5 h-5" />
          周營業狀況
        </button>
        <button 
          onClick={() => { setActiveTab('seating'); setIsSidebarOpen(false); }}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 ${
            activeTab === 'seating' 
              ? 'bg-gray-100 text-gray-900 font-semibold' 
              : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
          }`}
        >
          <Grid className="w-5 h-5" />
          帶位圖管理
        </button>
      </nav>
      <div className="p-4 border-t border-gray-100">
        <button 
          onClick={handleLogout} 
          className="w-full flex items-center justify-center gap-2 px-4 py-3 text-gray-500 hover:text-gray-900 hover:bg-gray-50 rounded-xl transition-all"
        >
          <LogOut className="w-5 h-5" />
          登出系統
        </button>
      </div>
    </>
  );

  return (
    <div className="h-screen overflow-hidden bg-gray-50 flex font-sans selection:bg-gray-200">
      {/* Mobile Sidebar Overlay */}
      {isSidebarOpen && (
        <div 
          className="fixed inset-0 bg-gray-900/20 backdrop-blur-sm z-40 md:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-gray-200 flex flex-col transition-transform duration-300 md:relative md:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <SidebarContent />
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Header (Mobile mainly) */}
        <header className="bg-white border-b border-gray-200 px-4 py-4 flex items-center justify-between md:hidden shadow-sm z-30">
          <div className="flex items-center gap-3">
            <div className="bg-gray-100 p-1.5 rounded-lg">
              <LayoutDashboard className="w-5 h-5 text-gray-800" />
            </div>
            <h1 className="text-lg font-bold text-gray-800">管理中心</h1>
          </div>
          <button onClick={() => setIsSidebarOpen(true)} className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg">
            <Menu className="w-6 h-6" />
          </button>
        </header>

        {/* Scrollable Area */}
        <main className={`flex-1 overflow-hidden ${activeTab === 'weekly' ? 'flex flex-col md:flex-row bg-white' : 'overflow-y-auto p-4 md:p-8 lg:p-10'}`}>
          {activeTab !== 'weekly' && (
            <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
              
              {/* --- TAB A: SESSIONS --- */}
              {activeTab === 'sessions' && (
              <>
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <h1 className="text-2xl font-bold text-gray-900 tracking-tight">營業時段設定</h1>
                    <p className="text-gray-500 mt-1 text-sm">建立並管理系統可供顧客預約的日期與時間段。</p>
                  </div>
                </div>

                <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
                  <div className="px-6 py-5 border-b border-gray-100 flex items-center gap-3">
                    <div className="bg-gray-100 p-2 rounded-lg"><Plus className="w-5 h-5 text-gray-600" /></div>
                    <h3 className="text-lg font-bold text-gray-800">新增時段</h3>
                  </div>
                  <div className="p-6">
                    <form onSubmit={handleCreateSession} className="flex flex-col gap-5">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">開始日期</label>
                          <input type="date" required value={sessionStartDate} onChange={e => { setSessionStartDate(e.target.value); if (sessionEndDate < e.target.value) setSessionEndDate(e.target.value); }} 
                            className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:bg-white outline-none transition-all" />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">結束日期</label>
                          <input type="date" required min={sessionStartDate} value={sessionEndDate} onChange={e => setSessionEndDate(e.target.value)} 
                            className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:bg-white outline-none transition-all" />
                        </div>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">開始時間</label>
                          <input type="time" required value={startTime} onChange={e => setStartTime(e.target.value)} 
                            className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:bg-white outline-none transition-all" />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">結束時間</label>
                          <input type="time" required value={endTime} onChange={e => setEndTime(e.target.value)} 
                            className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:bg-white outline-none transition-all" />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">人數</label>
                          <input type="number" min="1" required value={maxCapacity} onChange={e => setMaxCapacity(parseInt(e.target.value))} 
                            className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:bg-white outline-none transition-all" />
                        </div>
                        <div className="mt-4 md:mt-0">
                          <button type="submit" disabled={isSubmitting}
                            className="w-full bg-gray-900 hover:bg-gray-800 text-white py-2.5 px-4 rounded-xl font-bold transition-all disabled:opacity-70 flex justify-center items-center">
                            {isSubmitting ? '處理中...' : '新增'}
                          </button>
                        </div>
                      </div>
                    </form>
                  </div>
                </div>

                <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
                  <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                      <Clock className="w-5 h-5 text-gray-400" />
                      時段列表 
                      <div className="flex items-center gap-1 ml-2 bg-gray-50 p-1 rounded-lg border border-gray-200">
                        <button onClick={() => setListDate(format(addDays(new Date(listDate), -1), 'yyyy-MM-dd'))} className="px-2 py-1 hover:bg-white rounded text-gray-500 transition-colors shadow-sm">&lt;</button>
                        <input type="date" value={listDate} onChange={e => setListDate(e.target.value)} className="text-sm font-medium text-gray-700 bg-transparent px-1 outline-none" />
                        <button onClick={() => setListDate(format(addDays(new Date(listDate), 1), 'yyyy-MM-dd'))} className="px-2 py-1 hover:bg-white rounded text-gray-500 transition-colors shadow-sm">&gt;</button>
                      </div>
                    </h3>
                    {sessions.length > 0 && (
                      <button 
                        onClick={handleClearDay}
                        className="text-sm text-red-600 hover:text-red-700 hover:bg-red-50 px-3 py-1.5 rounded-lg border border-red-200 transition-colors flex items-center gap-1.5 font-medium"
                        title="清除本日所有無預約時段"
                      >
                        <Trash2 className="w-4 h-4" />
                        清除本日時段
                      </button>
                    )}
                  </div>
                  <div className="overflow-x-auto">
                    {isLoading ? (
                      <div className="p-10 flex justify-center"><div className="w-8 h-8 border-4 border-gray-200 border-t-gray-800 rounded-full animate-spin" /></div>
                    ) : (
                      <table className="w-full text-left whitespace-nowrap">
                        <thead>
                          <tr className="bg-gray-50/50 text-gray-500 text-sm border-b border-gray-100">
                            <th className="px-6 py-4 font-medium">營業時間</th>
                            <th className="px-6 py-4 font-medium">總人數限制</th>
                            <th className="px-6 py-4 font-medium">剩餘可約名額</th>
                            <th className="px-6 py-4 font-medium">狀態</th>
                            <th className="px-6 py-4 font-medium text-right">操作</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {sessions.length === 0 ? (
                            <tr><td colSpan="5" className="text-center py-12 text-gray-400">當日尚未建立任何時段</td></tr>
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
                                      className="text-gray-400 hover:text-red-500 p-2 rounded-lg transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
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
              </>
            )}

            {/* --- TAB B: RESERVATIONS --- */}
            {activeTab === 'reservations' && (
              <>
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <h1 className="text-2xl font-bold text-gray-900 tracking-tight">預約訂單總覽</h1>
                    <p className="text-gray-500 mt-1 text-sm">查看所有顧客的預約明細與狀態。</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <Search className="h-4 w-4 text-gray-400" />
                      </div>
                      <input
                        type="text"
                        placeholder="搜尋姓名或電話..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-10 pr-4 py-2 bg-white border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none text-sm transition-shadow w-full md:w-64"
                      />
                    </div>
                    <button 
                      onClick={() => setShowManualBooking(true)}
                      className="bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 flex items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors shadow-sm whitespace-nowrap"
                    >
                      <Plus className="w-4 h-4"/> 新增手動預約
                    </button>
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
                            <th className="px-6 py-4 font-medium">預約日期 / 時段</th>
                            <th className="px-6 py-4 font-medium">顧客資料</th>
                            <th className="px-6 py-4 font-medium text-center">人數</th>
                            <th className="px-6 py-4 font-medium">狀態</th>
                            <th className="px-6 py-4 font-medium text-right">建立時間</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {reservations.filter(r => {
                            if (!searchQuery) return true;
                            const q = searchQuery.toLowerCase();
                            return r.user.name.toLowerCase().includes(q) || r.user.phone.toLowerCase().includes(q);
                          }).length === 0 ? (
                            <tr><td colSpan="5" className="text-center py-16 text-gray-400">{searchQuery ? '找不到符合條件的預約' : '目前尚無預約紀錄'}</td></tr>
                          ) : (
                            reservations.filter(r => {
                              if (!searchQuery) return true;
                              const q = searchQuery.toLowerCase();
                              return r.user.name.toLowerCase().includes(q) || r.user.phone.toLowerCase().includes(q);
                            }).map(r => {
                              const isCancelled = r.status === 'cancelled';
                              const statusUI = getReservationStatusUI(r);
                              return (
                                <tr key={r.booking_ref} 
                                    onClick={() => setSelectedReservation(r)}
                                    className={`hover:bg-gray-50 transition-colors cursor-pointer ${isCancelled ? 'bg-gray-50/50' : ''}`}>
                                  <td className="px-6 py-4">
                                    <div className="flex flex-col">
                                      <span className={`font-semibold ${isCancelled ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                                        {format(new Date(r.session_date), 'yyyy/MM/dd')}
                                      </span>
                                      <span className="text-sm text-gray-500">{r.start_time} - {r.end_time} ({r.session_count}小時)</span>
                                    </div>
                                  </td>
                                  <td className="px-6 py-4">
                                    <div className="flex flex-col">
                                      <span className={`font-medium ${isCancelled ? 'text-gray-400' : 'text-gray-800'}`}>{r.user.name}</span>
                                      <span className="text-sm text-gray-500">{r.user.phone}</span>
                                    </div>
                                  </td>
                                  <td className="px-6 py-4 text-center">
                                    <span className={`inline-flex justify-center items-center w-8 h-8 rounded-lg ${isCancelled ? 'bg-gray-100 text-gray-400' : 'bg-gray-100 text-gray-900 font-bold'}`}>
                                      {r.pax}
                                    </span>
                                  </td>
                                  <td className="px-6 py-4">
                                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm font-medium ${statusUI.bgClass} ${statusUI.colorClass}`}>
                                      {statusUI.icon} {statusUI.text}
                                    </span>
                                  </td>
                                  <td className="px-6 py-4 text-right text-sm text-gray-400">
                                    {format(new Date(r.created_at), 'MM/dd HH:mm')}
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
              </>
            )}

            {/* --- TAB C: MEMBERS --- */}
            {activeTab === 'members' && (
              <>
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <h1 className="text-2xl font-bold text-gray-900 tracking-tight">會員管理</h1>
                    <p className="text-gray-500 mt-1 text-sm">管理顧客資料、歷史預約及黑名單狀態。</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <Search className="h-4 w-4 text-gray-400" />
                      </div>
                      <input
                        type="text"
                        placeholder="搜尋姓名或電話..."
                        value={memberSearchQuery}
                        onChange={(e) => setMemberSearchQuery(e.target.value)}
                        className="pl-10 pr-4 py-2 bg-white border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none text-sm transition-shadow w-full md:w-64"
                      />
                    </div>
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
                            <th className="px-6 py-4 font-medium">顧客資料</th>
                            <th className="px-6 py-4 font-medium">註冊時間</th>
                            <th className="px-6 py-4 font-medium">狀態</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {users.filter(u => {
                            if (!memberSearchQuery) return true;
                            const q = memberSearchQuery.toLowerCase();
                            return (u.name?.toLowerCase() || '').includes(q) || (u.phone?.toLowerCase() || '').includes(q);
                          }).length === 0 ? (
                            <tr><td colSpan="3" className="text-center py-16 text-gray-400">{memberSearchQuery ? '找不到符合條件的會員' : '目前尚無會員紀錄'}</td></tr>
                          ) : (
                            users.filter(u => {
                              if (!memberSearchQuery) return true;
                              const q = memberSearchQuery.toLowerCase();
                              return (u.name?.toLowerCase() || '').includes(q) || (u.phone?.toLowerCase() || '').includes(q);
                            }).map(u => (
                                <tr key={u.id} onClick={() => handleSelectMember(u)} className="hover:bg-gray-50 transition-colors cursor-pointer">
                                  <td className="px-6 py-4">
                                    <div className="flex flex-col">
                                      <span className={`font-medium ${u.is_blacklisted ? 'text-gray-400 line-through' : 'text-gray-800'}`}>{u.name || '未設定'}</span>
                                      <span className="text-sm text-gray-500">{u.phone || '未提供'}</span>
                                    </div>
                                  </td>
                                  <td className="px-6 py-4 text-sm text-gray-500">
                                    {format(new Date(u.created_at), 'yyyy/MM/dd')}
                                  </td>
                                  <td className="px-6 py-4">
                                    {u.is_blacklisted ? 
                                      <span className="inline-flex items-center gap-1.5 text-red-500 text-sm bg-red-50 px-2 py-1 rounded-md"><XCircle className="w-4 h-4"/>黑名單</span> : 
                                      <span className="inline-flex items-center gap-1.5 text-gray-500 text-sm">正常</span>}
                                  </td>
                                </tr>
                              ))
                          )}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              </>
            )}

          </div>
          )}

          {/* --- TAB D: WEEKLY OVERVIEW --- */}
          {activeTab === 'weekly' && (
            <>
              {/* Middle Column for Controls */}
              <div className="w-full md:w-64 lg:w-72 p-4 md:p-8 lg:p-10 shrink-0 flex flex-col gap-4 bg-gray-50 border-r border-gray-200 z-10">
                <h1 className="text-2xl font-bold text-gray-900 tracking-tight">周營業狀況</h1>
                <div className="flex flex-col gap-2 bg-white rounded-xl border border-gray-200 p-2 shadow-sm w-full">
                  <div className="text-center text-xs font-bold text-gray-400 tracking-wider">選擇日期區間</div>
                  <div className="flex items-center justify-between">
                    <button 
                      onClick={() => setWeeklyStartDate(format(addDays(new Date(weeklyStartDate), -7), 'yyyy-MM-dd'))}
                      className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-600 transition-colors"
                    >
                      <ChevronLeft className="w-5 h-5" />
                    </button>
                    <div className="font-bold text-gray-800 text-sm text-center">
                      <div>{format(new Date(weeklyStartDate), 'yyyy/MM/dd')}</div>
                      <div className="text-gray-400 font-normal">|</div>
                      <div>{format(addDays(new Date(weeklyStartDate), 6), 'yyyy/MM/dd')}</div>
                    </div>
                    <button 
                      onClick={() => setWeeklyStartDate(format(addDays(new Date(weeklyStartDate), 7), 'yyyy-MM-dd'))}
                      className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-600 transition-colors"
                    >
                      <ChevronRight className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              </div>

              {/* Right Column for Grid */}
              <div className="flex-1 overflow-auto bg-white relative animate-in fade-in duration-500">
                {isWeeklyLoading && (
                  <div className="absolute inset-0 bg-white/50 backdrop-blur-sm z-50 flex items-center justify-center">
                    <div className="w-8 h-8 border-4 border-gray-200 border-t-gray-800 rounded-full animate-spin" />
                  </div>
                )}
                <table className="w-full text-center border-collapse min-w-[800px]">
                  <thead className="sticky top-0 z-30 shadow-sm">
                    <tr>
                      <th className="p-3 border-b border-r border-gray-200 bg-white w-20 sticky left-0 z-40"></th>
                      {[0,1,2,3,4,5,6].map(dayOffset => {
                        const d = addDays(new Date(weeklyStartDate), dayOffset);
                        const isToday = format(d, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd');
                        return (
                          <th key={dayOffset} className={`p-3 border-b border-gray-200 font-medium ${isToday ? 'bg-gray-800 text-white' : 'bg-white text-gray-600'}`}>
                            <div className="text-sm">{['週日','週一','週二','週三','週四','週五','週六'][d.getDay()]}</div>
                            <div className={`text-xs mt-0.5 ${isToday ? 'text-gray-300' : 'text-gray-400'}`}>{format(d, 'MM/dd')}</div>
                          </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: 24 }).map((_, hour) => {
                      const timeString = `${hour.toString().padStart(2, '0')}:00`;
                      return (
                        <tr key={hour}>
                          <td className="p-2 border-b border-r border-gray-100 bg-gray-50 text-xs text-gray-500 font-medium sticky left-0 z-10">
                            {timeString}
                          </td>
                          {[0,1,2,3,4,5,6].map(dayOffset => {
                            const d = addDays(new Date(weeklyStartDate), dayOffset);
                            const dateStr = format(d, 'yyyy-MM-dd');
                            
                            const session = weeklySessions.find(s => 
                              format(new Date(s.session_date), 'yyyy-MM-dd') === dateStr &&
                              s.start_time <= timeString && 
                              s.end_time > timeString
                            );

                            let cellContent = null;
                            let bgClass = "bg-white hover:bg-gray-50/50";
                            
                            if (session) {
                              const bookedPax = session.max_capacity - session.remaining_capacity;
                              const isFull = session.remaining_capacity <= 0;
                              
                              if (isFull) {
                                bgClass = "bg-amber-100/70 hover:bg-amber-200/80";
                                cellContent = <span className="text-amber-800 font-bold text-sm">{bookedPax} 人</span>;
                              } else {
                                bgClass = "bg-slate-100/70 hover:bg-slate-200/80";
                                cellContent = bookedPax > 0 ? <span className="text-slate-700 font-semibold text-sm">{bookedPax} 人</span> : null;
                              }
                            }

                            return (
                              <td key={dayOffset} className={`p-2 border-b border-gray-100 border-l ${bgClass} h-12 transition-colors`}>
                                {cellContent}
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Seating Chart */}
          {activeTab === 'seating' && (
            <AdminSeatingChart 
              onOpenDetails={(booking_ref) => {
                const res = reservations.find(r => r.booking_ref === booking_ref);
                if (res) setSelectedReservation(res);
              }}
              onCheckIn={(booking_ref) => handleUpdateAttendance(booking_ref, 'checked_in')}
            />
          )}

        </main>
      </div>

      {/* Manual Booking Modal */}
      {showManualBooking && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={() => setShowManualBooking(false)} />
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden relative z-10 animate-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-xl font-bold text-gray-800">新增手動預約</h2>
              <button onClick={() => setShowManualBooking(false)} className="p-2 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100 transition-colors">
                <XCircle className="w-6 h-6" />
              </button>
            </div>
            
            <form onSubmit={handleManualSubmit} className="p-6 overflow-y-auto max-h-[70vh]">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">顧客姓名</label>
                  <input type="text" required value={manualName} onChange={e => setManualName(e.target.value)} placeholder="例：王小明"
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">聯絡電話</label>
                  <input type="tel" required value={manualPhone} onChange={e => setManualPhone(e.target.value)} placeholder="例：0912345678"
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 outline-none" />
                </div>
              </div>

              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">預約日期</label>
                <input type="date" required value={manualDate} onChange={e => setManualDate(e.target.value)}
                  className="w-full md:w-1/2 px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 outline-none" />
              </div>

              <div className="mb-6">
                <div className="flex justify-between items-center mb-2">
                  <label className="block text-sm font-medium text-gray-700">選擇時段 (可複選)</label>
                  {manualSelectedSessions.length > 0 && (
                    <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-md">已選 {manualSelectedSessions.length} 小時</span>
                  )}
                </div>
                
                {isManualLoading ? (
                  <div className="text-gray-400 py-4 text-center text-sm">載入中...</div>
                ) : manualSessions.length === 0 ? (
                  <div className="text-gray-400 py-4 text-center text-sm bg-gray-50 rounded-xl border border-gray-100">該日期無開放時段</div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {manualSessions.map(session => {
                      const isFull = session.remaining_capacity === 0;
                      const isSelected = !!manualSelectedSessions.find(s => s.id === session.id);
                      return (
                        <button
                          key={session.id} type="button" disabled={isFull} onClick={() => toggleManualSession(session)}
                          className={`p-3 rounded-xl border flex flex-col items-center transition-all ${
                            isFull ? 'bg-gray-50 border-gray-100 text-gray-400 opacity-60 cursor-not-allowed' 
                                   : isSelected ? 'border-gray-900 bg-gray-900 text-white shadow-md' 
                                                : 'border-gray-200 text-gray-700 hover:border-gray-400 hover:bg-gray-50'
                          }`}
                        >
                          <span className="font-bold text-sm">{session.start_time}</span>
                          <span className="text-xs opacity-80">{isFull ? '已滿' : `剩 ${session.remaining_capacity} 人`}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              {manualSelectedSessions.length > 0 && manualMaxPax > 0 && (
                <div className="mb-6 animate-in fade-in slide-in-from-bottom-2">
                  <label className="block text-sm font-medium text-gray-700 mb-2">預約人數 (最多 {manualMaxPax} 人)</label>
                  <select 
                    value={manualPax} onChange={(e) => setManualPax(parseInt(e.target.value))}
                    className="w-full md:w-1/2 px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 outline-none"
                  >
                    {Array.from({ length: manualMaxPax }).map((_, i) => (
                      <option key={i + 1} value={i + 1}>{i + 1} 人</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="pt-4 border-t border-gray-100 flex justify-end gap-3">
                <button type="button" onClick={() => setShowManualBooking(false)} className="px-5 py-2.5 text-gray-600 hover:bg-gray-100 rounded-xl font-medium transition-colors">取消</button>
                <button type="submit" disabled={manualSelectedSessions.length === 0} className="px-6 py-2.5 bg-gray-900 hover:bg-gray-800 disabled:opacity-50 text-white rounded-xl font-bold transition-colors">確認預約</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Member Details Modal */}
      {selectedMember && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={() => setSelectedMember(null)} />
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl overflow-hidden relative z-10 animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
              <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                <UserCog className="w-5 h-5 text-gray-500" />
                會員詳細資料
              </h2>
              <button onClick={() => setSelectedMember(null)} className="p-2 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-200 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto flex-1">
              {/* Member Info & Controls */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                <div className="space-y-4">
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">顧客姓名</h3>
                    <p className="text-lg font-bold text-gray-900">{selectedMember.name || '未設定'}</p>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">聯絡電話</h3>
                    <p className="text-lg font-bold text-gray-900">{selectedMember.phone || '未提供'}</p>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">註冊時間</h3>
                    <p className="text-md text-gray-800">{format(new Date(selectedMember.created_at), 'yyyy/MM/dd HH:mm')}</p>
                  </div>
                </div>
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-gray-700">黑名單狀態</span>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" className="sr-only peer" checked={selectedMember.is_blacklisted} 
                        onChange={(e) => handleUpdateMember(selectedMember.id, { is_blacklisted: e.target.checked })} />
                      <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-500"></div>
                    </label>
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-bold text-gray-700">會員備註</span>
                      {isSavingNotes && <span className="text-xs text-gray-400">儲存中...</span>}
                    </div>
                    <textarea 
                      className="w-full h-24 p-3 bg-white border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-gray-900 outline-none resize-none"
                      placeholder="填寫關於此顧客的備註事項..."
                      defaultValue={selectedMember.notes || ''}
                      onBlur={(e) => {
                        if (e.target.value !== (selectedMember.notes || '')) {
                          handleUpdateMember(selectedMember.id, { notes: e.target.value });
                        }
                      }}
                    />
                    <p className="text-xs text-gray-400 mt-1">輸入完畢後點擊空白處即可自動儲存</p>
                  </div>
                </div>
              </div>

              {/* Reservation History */}
              <h3 className="text-lg font-bold text-gray-800 mb-4 border-b border-gray-100 pb-2">歷史預約紀錄</h3>
              {isMemberLoading ? (
                <div className="py-8 flex justify-center"><div className="w-6 h-6 border-2 border-gray-200 border-t-gray-800 rounded-full animate-spin" /></div>
              ) : memberReservations.length === 0 ? (
                <div className="text-center py-8 text-gray-400 bg-gray-50 rounded-xl border border-gray-100">無預約紀錄</div>
              ) : (
                <div className="space-y-3">
                  {Object.values(memberReservations.reduce((acc, curr) => {
                    const ref = curr.booking_ref;
                    if (!acc[ref]) {
                      acc[ref] = { ...curr, session: { ...curr.session }, session_count: 1 };
                    } else {
                      acc[ref].session_count += 1;
                      if (curr.session.end_time > acc[ref].session.end_time) acc[ref].session.end_time = curr.session.end_time;
                      if (curr.session.start_time < acc[ref].session.start_time) acc[ref].session.start_time = curr.session.start_time;
                    }
                    return acc;
                  }, {})).sort((a, b) => new Date(b.session.session_date) - new Date(a.session.session_date) || b.session.start_time.localeCompare(a.session.start_time)).map(r => {
                    const isCancelled = r.status === 'cancelled';
                    return (
                      <div key={r.booking_ref} className={`p-4 rounded-xl border flex items-center justify-between ${isCancelled ? 'bg-gray-50 border-gray-100' : 'bg-white border-gray-200'}`}>
                        <div className="flex items-center gap-4">
                          <div className={`w-12 h-12 rounded-lg flex flex-col items-center justify-center ${isCancelled ? 'bg-gray-100 text-gray-400' : 'bg-gray-900 text-white'}`}>
                            <span className="text-xs font-medium">{format(new Date(r.session.session_date), 'MM/dd')}</span>
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className={`font-bold ${isCancelled ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                                {r.session.start_time} - {r.session.end_time}
                              </span>
                              <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{r.pax} 人</span>
                            </div>
                            <div className="text-xs text-gray-500 mt-1">訂單編號: {r.booking_ref.slice(0,8)}...</div>
                          </div>
                        </div>
                        <div>
                          {isCancelled ? 
                            <span className="inline-flex items-center gap-1 text-gray-400 text-xs font-medium"><XCircle className="w-3.5 h-3.5"/> 已取消</span> : 
                            <span className="inline-flex items-center gap-1 text-green-600 text-xs font-medium"><CheckCircle2 className="w-3.5 h-3.5"/> 預約成功</span>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Reservation Details Modal */}
      {selectedReservation && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={() => setSelectedReservation(null)} />
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden relative z-10 animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
              <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                訂單詳細資訊
              </h2>
              <button onClick={() => setSelectedReservation(null)} className="p-2 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-200 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto flex-1">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                <div className="space-y-4">
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">訂單編號</h3>
                    <p className="text-sm text-gray-800 font-mono">{selectedReservation.booking_ref}</p>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">顧客姓名</h3>
                    <p className="text-lg font-bold text-gray-900">{selectedReservation.user.name || '未設定'}</p>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">聯絡電話</h3>
                    <p className="text-lg font-bold text-gray-900">{selectedReservation.user.phone || '未提供'}</p>
                  </div>
                </div>
                
                <div className="space-y-4">
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">預約時間</h3>
                    <p className="text-lg font-bold text-gray-900">
                      {format(new Date(selectedReservation.session_date), 'yyyy/MM/dd')}
                      <span className="text-gray-500 text-sm ml-2 font-normal">
                        {selectedReservation.start_time} - {selectedReservation.end_time} ({selectedReservation.session_count}小時)
                      </span>
                    </p>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">人數</h3>
                    <p className="text-lg font-bold text-gray-900">{selectedReservation.pax} 人</p>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-1">當前狀態</h3>
                    <div className="mt-1">
                      {(() => {
                        const statusUI = getReservationStatusUI(selectedReservation);
                        return (
                          <div className="flex items-center">
                            <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium ${statusUI.bgClass} ${statusUI.colorClass}`}>
                              {statusUI.icon} {statusUI.text}
                            </span>
                            {selectedReservation.is_force_split && (
                              <span className="ml-2 inline-flex items-center px-2 py-1 bg-amber-50 text-amber-600 border border-amber-200 rounded-md text-xs font-bold tracking-wide">
                                顧客同意拆桌
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="pt-6 border-t border-gray-100">
                <h3 className="text-sm font-medium text-gray-500 mb-3">訂單操作</h3>
                {selectedReservation.status === 'cancelled' ? (
                  <div className="flex items-center justify-between">
                    <p className="text-gray-500 text-sm">此訂單已取消。</p>
                    <button 
                      onClick={() => handleDeleteReservationRecord(selectedReservation.booking_ref)}
                      className="px-4 py-2 bg-red-50 text-red-600 hover:bg-red-100 rounded-xl font-medium transition-colors flex items-center gap-2 text-sm border border-red-100"
                    >
                      <Trash2 className="w-4 h-4" />
                      刪除紀錄
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-3">
                    <button 
                      onClick={() => handleUpdateAttendance(selectedReservation.booking_ref, 'checked_in')}
                      disabled={selectedReservation.attendance === 'checked_in'}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white rounded-xl font-medium transition-colors flex items-center gap-2"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      完成報到
                    </button>
                    <button 
                      onClick={() => handleUpdateAttendance(selectedReservation.booking_ref, 'no_show')}
                      disabled={selectedReservation.attendance === 'no_show'}
                      className="px-4 py-2 bg-gray-600 hover:bg-gray-700 disabled:bg-gray-300 text-white rounded-xl font-medium transition-colors flex items-center gap-2"
                    >
                      <XCircle className="w-4 h-4" />
                      標記未到
                    </button>
                    <button 
                      onClick={() => handleUpdateAttendance(selectedReservation.booking_ref, null)}
                      disabled={!selectedReservation.attendance}
                      className="px-4 py-2 bg-white border border-gray-200 hover:bg-gray-50 disabled:bg-gray-50 disabled:text-gray-400 text-gray-700 rounded-xl font-medium transition-colors"
                    >
                      清除報到標記
                    </button>
                    
                    <div className="flex-1"></div>
                    
                    <button 
                      onClick={() => {
                        if(confirm('確定要取消此預約嗎？此操作無法復原。')) {
                          handleCancelReservation(selectedReservation.booking_ref);
                          setSelectedReservation(null);
                        }
                      }}
                      className="px-4 py-2 text-red-600 bg-red-50 hover:bg-red-100 rounded-xl font-medium transition-colors"
                    >
                      取消預約
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <style dangerouslySetInnerHTML={{__html: `
        .animate-in { animation: animateIn 0.4s ease-out forwards; }
        @keyframes animateIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      `}} />
    </div>
  );
}

export default AdminDashboard;
