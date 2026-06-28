import React, { useState, useEffect } from 'react';
import { BarChart3, FileText, AlertTriangle, Download, Calendar, DollarSign, Users, ShoppingCart } from 'lucide-react';
import { format, startOfMonth, endOfMonth, startOfWeek, endOfWeek, subDays, startOfDay, endOfDay } from 'date-fns';
import api from '../../api/axios';
import ReservationDetailsModal from '../../components/ReservationDetailsModal';

export default function AccountingPage() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [startDate, setStartDate] = useState(format(startOfDay(new Date()), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState(format(endOfDay(new Date()), 'yyyy-MM-dd'));

  const [summary, setSummary] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [unpaid, setUnpaid] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  const [selectedReservationRef, setSelectedReservationRef] = useState(null);

  useEffect(() => {
    fetchData();
  }, [startDate, endDate, activeTab]);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      if (activeTab === 'dashboard') {
        const res = await api.get(`/accounting/summary?start_date=${startDate}&end_date=${endDate}`);
        setSummary(res.data);
      } else if (activeTab === 'ledger') {
        const res = await api.get(`/accounting/ledger?start_date=${startDate}&end_date=${endDate}`);
        setLedger(res.data);
      } else if (activeTab === 'unpaid') {
        const res = await api.get(`/accounting/unpaid`);
        setUnpaid(res.data);
      }
    } catch (err) {
      console.error(err);
      alert('無法取得帳務資料');
    } finally {
      setIsLoading(false);
    }
  };

  const handleExportCSV = () => {
    if (ledger.length === 0) {
      alert('沒有資料可匯出');
      return;
    }
    
    // Create CSV content
    const headers = ['預約日期', '入帳時間', '訂單編號', '顧客姓名', '聯絡電話', '結帳金額'];
    const rows = ledger.map(item => [
      format(new Date(item.session.session_date), 'yyyy-MM-dd'),
      item.paid_at ? format(new Date(item.paid_at), 'yyyy-MM-dd HH:mm:ss') : '',
      item.booking_ref,
      item.user?.name || '',
      item.user?.phone || '',
      item.total_amount || 0
    ]);
    
    const csvContent = "data:text/csv;charset=utf-8,\uFEFF" 
      + headers.join(',') + '\n' 
      + rows.map(e => e.join(',')).join('\n');
      
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `帳務報表_${startDate}_至_${endDate}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const setDateRange = (range) => {
    const today = new Date();
    switch (range) {
      case 'today':
        setStartDate(format(startOfDay(today), 'yyyy-MM-dd'));
        setEndDate(format(endOfDay(today), 'yyyy-MM-dd'));
        break;
      case 'week':
        setStartDate(format(startOfWeek(today, { weekStartsOn: 1 }), 'yyyy-MM-dd'));
        setEndDate(format(endOfWeek(today, { weekStartsOn: 1 }), 'yyyy-MM-dd'));
        break;
      case 'month':
        setStartDate(format(startOfMonth(today), 'yyyy-MM-dd'));
        setEndDate(format(endOfMonth(today), 'yyyy-MM-dd'));
        break;
      default:
        break;
    }
  };

  return (
    <div className="p-4 md:p-8 space-y-8 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight">帳務管理</h1>
        <p className="text-gray-500 mt-1 text-sm">檢視營業額、匯出帳務報表、以及追蹤未收款項。</p>
      </div>

      {/* Tabs */}
      <div className="flex space-x-1 bg-gray-100 p-1 rounded-xl max-w-fit">
        <button
          onClick={() => setActiveTab('dashboard')}
          className={`flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium transition-all ${
            activeTab === 'dashboard' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-200'
          }`}
        >
          <BarChart3 className="w-4 h-4" />
          營收儀表板
        </button>
        <button
          onClick={() => setActiveTab('ledger')}
          className={`flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium transition-all ${
            activeTab === 'ledger' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-200'
          }`}
        >
          <FileText className="w-4 h-4" />
          流水帳明細
        </button>
        <button
          onClick={() => setActiveTab('unpaid')}
          className={`flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium transition-all ${
            activeTab === 'unpaid' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-200'
          }`}
        >
          <AlertTriangle className="w-4 h-4" />
          待收帳款
        </button>
      </div>

      {/* Date Filters (Only for Dashboard and Ledger) */}
      {activeTab !== 'unpaid' && (
        <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Calendar className="w-5 h-5 text-gray-400" />
            <span className="text-sm font-bold text-gray-700">期間設定</span>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setDateRange('today')} className="px-3 py-1.5 text-xs font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors">今日</button>
            <button onClick={() => setDateRange('week')} className="px-3 py-1.5 text-xs font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors">本週</button>
            <button onClick={() => setDateRange('month')} className="px-3 py-1.5 text-xs font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors">本月</button>
          </div>
          <div className="h-6 w-px bg-gray-200 hidden md:block"></div>
          <div className="flex items-center gap-2">
            <input 
              type="date" 
              value={startDate} 
              onChange={(e) => setStartDate(e.target.value)}
              className="text-sm border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500"
            />
            <span className="text-gray-400 text-sm">至</span>
            <input 
              type="date" 
              value={endDate} 
              onChange={(e) => setEndDate(e.target.value)}
              className="text-sm border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>
          {activeTab === 'ledger' && (
            <button 
              onClick={handleExportCSV}
              className="ml-auto flex items-center gap-2 px-4 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-sm font-bold transition-colors border border-indigo-200"
            >
              <Download className="w-4 h-4" />
              匯出 CSV
            </button>
          )}
        </div>
      )}

      {/* Content Area */}
      {isLoading ? (
        <div className="flex justify-center p-12">
          <div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
        </div>
      ) : (
        <>
          {activeTab === 'dashboard' && summary && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 animate-fade-in">
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200 border-l-4 border-l-green-500">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-gray-500 font-medium text-sm">總實收金額</h3>
                  <div className="p-2 bg-green-50 rounded-lg text-green-600"><DollarSign className="w-5 h-5"/></div>
                </div>
                <div className="text-3xl font-black text-gray-900">NT$ {summary.totalRevenue.toLocaleString()}</div>
              </div>

              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200 border-l-4 border-l-indigo-500">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-gray-500 font-medium text-sm">已付款訂單</h3>
                  <div className="p-2 bg-indigo-50 rounded-lg text-indigo-600"><ShoppingCart className="w-5 h-5"/></div>
                </div>
                <div className="text-3xl font-black text-gray-900">{summary.paidCount} <span className="text-sm font-normal text-gray-400">筆</span></div>
              </div>

              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200 border-l-4 border-l-blue-500">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-gray-500 font-medium text-sm">總來客數 (已付)</h3>
                  <div className="p-2 bg-blue-50 rounded-lg text-blue-600"><Users className="w-5 h-5"/></div>
                </div>
                <div className="text-3xl font-black text-gray-900">{summary.totalPax} <span className="text-sm font-normal text-gray-400">人</span></div>
              </div>

              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200 border-l-4 border-l-purple-500">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-gray-500 font-medium text-sm">平均客單價</h3>
                  <div className="p-2 bg-purple-50 rounded-lg text-purple-600"><BarChart3 className="w-5 h-5"/></div>
                </div>
                <div className="text-3xl font-black text-gray-900">NT$ {summary.avgPrice.toLocaleString()}</div>
              </div>
            </div>
          )}

          {activeTab === 'ledger' && (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden animate-fade-in">
              <div className="overflow-x-auto">
                <table className="w-full text-left whitespace-nowrap">
                  <thead>
                    <tr className="bg-gray-50 text-gray-500 text-sm border-b border-gray-200">
                      <th className="px-6 py-4 font-medium">預約日期</th>
                      <th className="px-6 py-4 font-medium">入帳時間</th>
                      <th className="px-6 py-4 font-medium">顧客</th>
                      <th className="px-6 py-4 font-medium">實收金額</th>
                      <th className="px-6 py-4 font-medium text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {ledger.length === 0 ? (
                      <tr><td colSpan="5" className="text-center py-16 text-gray-400">此期間無入帳紀錄</td></tr>
                    ) : (
                      ledger.map((item) => (
                        <tr key={item.id} className="hover:bg-gray-50">
                          <td className="px-6 py-4">
                            <span className="font-medium text-gray-900">{format(new Date(item.session.session_date), 'yyyy-MM-dd')}</span>
                          </td>
                          <td className="px-6 py-4 text-gray-500 text-sm">
                            {item.paid_at ? format(new Date(item.paid_at), 'yyyy-MM-dd HH:mm:ss') : '-'}
                          </td>
                          <td className="px-6 py-4">
                            <div className="font-bold text-gray-900">{item.user?.name}</div>
                            <div className="text-sm text-gray-500">{item.user?.phone}</div>
                          </td>
                          <td className="px-6 py-4">
                            <span className="font-bold text-green-600 bg-green-50 px-2 py-1 rounded-lg">NT$ {item.total_amount || 0}</span>
                          </td>
                          <td className="px-6 py-4 text-right">
                            <button 
                              onClick={() => setSelectedReservationRef(item.booking_ref)}
                              className="text-indigo-600 hover:text-indigo-900 text-sm font-bold bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-lg transition-colors"
                            >
                              詳情
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'unpaid' && (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden animate-fade-in">
              <div className="p-6 bg-red-50 border-b border-red-100">
                <h2 className="text-red-800 font-bold flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5" />
                  待收帳款 (已入座未結帳)
                </h2>
                <p className="text-red-600 text-sm mt-1">此列表顯示「已經報到入座 (2026-06-28 起至今日)」，但「尚未標記為已付款」的訂單，方便您進行帳務追蹤與防呆。</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left whitespace-nowrap">
                  <thead>
                    <tr className="bg-gray-50 text-gray-500 text-sm border-b border-gray-200">
                      <th className="px-6 py-4 font-medium">預約日期</th>
                      <th className="px-6 py-4 font-medium">顧客</th>
                      <th className="px-6 py-4 font-medium">聯絡電話</th>
                      <th className="px-6 py-4 font-medium">預估金額</th>
                      <th className="px-6 py-4 font-medium text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {unpaid.length === 0 ? (
                      <tr><td colSpan="5" className="text-center py-16 text-gray-400">目前沒有未收款項的訂單</td></tr>
                    ) : (
                      unpaid.map((item) => (
                        <tr key={item.id} className="hover:bg-red-50/50">
                          <td className="px-6 py-4">
                            <span className="font-bold text-gray-900">{format(new Date(item.session.session_date), 'yyyy-MM-dd')}</span>
                          </td>
                          <td className="px-6 py-4 font-bold text-gray-900">{item.user?.name}</td>
                          <td className="px-6 py-4 text-gray-500">{item.user?.phone}</td>
                          <td className="px-6 py-4">
                            {item.total_amount ? (
                              <span className="font-bold text-gray-700">NT$ {item.total_amount}</span>
                            ) : (
                              <span className="text-gray-400 text-sm">-</span>
                            )}
                          </td>
                          <td className="px-6 py-4 text-right">
                            <button 
                              onClick={() => setSelectedReservationRef(item.booking_ref)}
                              className="text-red-600 hover:text-red-900 text-sm font-bold bg-red-50 hover:bg-red-100 border border-red-200 px-3 py-1.5 rounded-lg transition-colors"
                            >
                              前往結帳
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Reservation Details Modal wrapper */}
      {selectedReservationRef && (
        <ReservationDetailsWrapper 
          bookingRef={selectedReservationRef}
          onClose={() => {
            setSelectedReservationRef(null);
            fetchData(); // Refresh data after modal closes in case payment status changed
          }} 
        />
      )}
    </div>
  );
}

// Wrapper to fetch and display details
function ReservationDetailsWrapper({ bookingRef, onClose }) {
  const [reservation, setReservation] = useState(null);
  
  useEffect(() => {
    const fetchRes = async () => {
      try {
        const res = await api.get(`/reservations/admin/${bookingRef}/details`);
        setReservation(res.data);
      } catch (err) {
        console.error(err);
        alert('無法取得訂單詳情');
        onClose();
      }
    };
    fetchRes();
  }, [bookingRef]);

  if (!reservation) return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"><div className="w-8 h-8 border-4 border-white border-t-transparent rounded-full animate-spin"></div></div>;

  return (
    <ReservationDetailsModal 
      reservation={reservation} 
      onClose={onClose}
      onUpdate={(updates) => setReservation(prev => ({...prev, ...updates}))}
    />
  );
}
