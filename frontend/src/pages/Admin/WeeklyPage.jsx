import React, { useState, useEffect } from 'react';
import { format, addDays } from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import api from '../../api/axios';

export default function WeeklyPage() {
  const [weeklyStartDate, setWeeklyStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - d.getDay()); // Sunday
    return format(d, 'yyyy-MM-dd');
  });
  const [weeklySessions, setWeeklySessions] = useState([]);
  const [isWeeklyLoading, setIsWeeklyLoading] = useState(false);

  useEffect(() => {
    fetchWeeklySessions();
  }, [weeklyStartDate]);

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

  return (
    <div className="flex flex-col md:flex-row h-full animate-fade-in">
      {/* Left/Top Column for Controls */}
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
      <div className="flex-1 overflow-auto bg-white relative">
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
    </div>
  );
}
