import React, { useState, useEffect, useMemo } from 'react';
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

  const displayHours = useMemo(() => {
    if (!weeklySessions || weeklySessions.length === 0) {
      // 這週完全沒有時段時，顯示 10:00～21:00
      return Array.from({ length: 12 }, (_, i) => 10 + i); // 10..21
    }

    let earliestHour = 24;
    let latestHour = -1;

    for (const s of weeklySessions) {
      if (s.start_time) {
        const [sh] = s.start_time.split(':').map(Number);
        if (!isNaN(sh) && sh < earliestHour) earliestHour = sh;
      }
      if (s.end_time) {
        const [eh, em] = s.end_time.split(':').map(Number);
        if (!isNaN(eh)) {
          const endH = (em || 0) > 0 ? eh + 1 : eh;
          if (endH > latestHour) latestHour = endH;
        }
      }
    }

    if (earliestHour > 23 || latestHour < 0) {
      return Array.from({ length: 12 }, (_, i) => 10 + i);
    }

    const startH = Math.max(0, earliestHour - 1);
    const endH = Math.min(23, latestHour + 1);
    const hours = [];
    for (let h = startH; h <= endH; h++) {
      hours.push(h);
    }
    return hours;
  }, [weeklySessions]);

  return (
    <div className="flex flex-col md:flex-row h-full animate-fade-in gap-4 max-w-full overflow-hidden">
      {/* Left/Top Column for Controls */}
      <div className="w-full md:w-64 lg:w-72 shrink-0 flex flex-col gap-4 z-10">
        <div className="flex flex-col gap-2 bg-white rounded-3xl border border-sg-line p-3 shadow-xs w-full">
          <div className="text-center text-[12px] font-bold text-sg-muted tracking-wider">選擇日期區間</div>
          <div className="flex items-center justify-between">
            <button 
              onClick={() => setWeeklyStartDate(format(addDays(new Date(weeklyStartDate), -7), 'yyyy-MM-dd'))}
              className="p-1.5 hover:bg-sg-paper rounded-xl text-sg-ink transition-colors"
              aria-label="前一週"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <div className="font-bold text-sg-ink text-[13px] text-center">
              <div>{format(new Date(weeklyStartDate), 'yyyy/MM/dd')}</div>
              <div className="text-sg-muted font-normal text-[12px]">至</div>
              <div>{format(addDays(new Date(weeklyStartDate), 6), 'yyyy/MM/dd')}</div>
            </div>
            <button 
              onClick={() => setWeeklyStartDate(format(addDays(new Date(weeklyStartDate), 7), 'yyyy-MM-dd'))}
              className="p-1.5 hover:bg-sg-paper rounded-xl text-sg-ink transition-colors"
              aria-label="後一週"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Right Column for Grid */}
      <div className="flex-1 w-full max-w-full overflow-x-auto bg-white rounded-3xl border border-sg-line relative shadow-xs">
        {isWeeklyLoading && (
          <div className="absolute inset-0 bg-white/60 backdrop-blur-xs z-50 flex items-center justify-center">
            <div className="w-8 h-8 border-4 border-sg-line border-t-sg-brown rounded-full animate-spin" />
          </div>
        )}
        <table className="w-full text-center border-collapse min-w-[700px]">
          <thead className="sticky top-0 z-30 shadow-xs">
            <tr>
              <th className="p-3 border-b border-r border-sg-line bg-white w-20 sticky left-0 z-40"></th>
              {[0,1,2,3,4,5,6].map(dayOffset => {
                const d = addDays(new Date(weeklyStartDate), dayOffset);
                const isToday = format(d, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd');
                return (
                  <th key={dayOffset} className={`p-3 border-b border-sg-line font-medium ${isToday ? 'bg-sg-brown text-white' : 'bg-white text-sg-ink'}`}>
                    <div className="text-[13px] font-bold">{['週日','週一','週二','週三','週四','週五','週六'][d.getDay()]}</div>
                    <div className={`text-[12px] mt-0.5 ${isToday ? 'text-white/80' : 'text-sg-muted'}`}>{format(d, 'MM/dd')}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {displayHours.map((hour) => {
              const timeString = `${hour.toString().padStart(2, '0')}:00`;
              return (
                <tr key={hour}>
                  <td className="p-2 border-b border-r border-sg-line bg-sg-paper/60 text-[12px] text-sg-muted font-bold sticky left-0 z-10">
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
                    let bgClass = "bg-white hover:bg-sg-paper/40";
                    
                    if (session) {
                      const bookedPax = session.max_capacity - session.remaining_capacity;
                      const isFull = session.remaining_capacity <= 0;
                      
                      if (isFull) {
                        bgClass = "bg-sg-peach-soft hover:bg-sg-peach-soft/80";
                        cellContent = <span className="text-sg-peach font-bold text-[13px]">{bookedPax} 人 (滿)</span>;
                      } else {
                        bgClass = bookedPax > 0 ? "bg-sg-brown-soft/40 hover:bg-sg-brown-soft/70" : "bg-white hover:bg-sg-paper/40";
                        cellContent = bookedPax > 0 ? <span className="text-sg-brown font-bold text-[13px]">{bookedPax} 人</span> : null;
                      }
                    }

                    return (
                      <td key={dayOffset} className={`p-2 border-b border-sg-line border-l border-sg-line/60 ${bgClass} h-12 transition-colors`}>
                        {cellContent}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
