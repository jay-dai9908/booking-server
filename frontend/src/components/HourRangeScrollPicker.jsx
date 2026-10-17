import React, { useRef, useEffect } from 'react';
import { ChevronUp, ChevronDown, Clock } from 'lucide-react';

const START_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
const END_HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
const ITEM_HEIGHT = 40; // 40px

export default function HourRangeScrollPicker({ startTime, setStartTime, endTime, setEndTime }) {
  const startH = parseInt((startTime || '13:00').split(':')[0], 10);
  const endH = parseInt((endTime || '21:00').split(':')[0], 10);

  const startContainerRef = useRef(null);
  const endContainerRef = useRef(null);
  
  // Lock flag to prevent onScroll from overriding programmatic selection
  const isProgrammaticRef = useRef(false);
  const programmaticTimerRef = useRef(null);
  const startScrollTimerRef = useRef(null);
  const endScrollTimerRef = useRef(null);

  // Scroll to active index
  const scrollWheelToIndex = (container, index, smooth = true) => {
    if (!container) return;
    const targetTop = index * ITEM_HEIGHT;
    if (Math.abs(container.scrollTop - targetTop) < 2) return;

    isProgrammaticRef.current = true;
    if (programmaticTimerRef.current) {
      clearTimeout(programmaticTimerRef.current);
    }

    container.scrollTo({
      top: targetTop,
      behavior: smooth ? 'smooth' : 'auto'
    });

    programmaticTimerRef.current = setTimeout(() => {
      isProgrammaticRef.current = false;
    }, smooth ? 450 : 50);
  };

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (programmaticTimerRef.current) clearTimeout(programmaticTimerRef.current);
      if (startScrollTimerRef.current) clearTimeout(startScrollTimerRef.current);
      if (endScrollTimerRef.current) clearTimeout(endScrollTimerRef.current);
    };
  }, []);

  // Center wheels on mount and when props change externally
  useEffect(() => {
    if (isProgrammaticRef.current) return;
    const sIdx = START_HOURS.indexOf(startH);
    if (sIdx >= 0 && startContainerRef.current) {
      const targetTop = sIdx * ITEM_HEIGHT;
      if (Math.abs(startContainerRef.current.scrollTop - targetTop) > 2) {
        scrollWheelToIndex(startContainerRef.current, sIdx, false);
      }
    }
  }, [startH]);

  useEffect(() => {
    if (isProgrammaticRef.current) return;
    const eIdx = END_HOURS.indexOf(endH);
    if (eIdx >= 0 && endContainerRef.current) {
      const targetTop = eIdx * ITEM_HEIGHT;
      if (Math.abs(endContainerRef.current.scrollTop - targetTop) > 2) {
        scrollWheelToIndex(endContainerRef.current, eIdx, false);
      }
    }
  }, [endH]);

  const handleSelectStart = (h, shouldScroll = true) => {
    const formatted = `${h.toString().padStart(2, '0')}:00`;
    setStartTime(formatted);
    if (shouldScroll) {
      const sIdx = START_HOURS.indexOf(h);
      if (sIdx >= 0 && startContainerRef.current) {
        scrollWheelToIndex(startContainerRef.current, sIdx, true);
      }
    }
    // Auto-advance endTime if endH <= h
    if (endH <= h) {
      const nextEnd = Math.min(23, h + 1);
      setEndTime(`${nextEnd.toString().padStart(2, '0')}:00`);
      if (shouldScroll) {
        const eIdx = END_HOURS.indexOf(nextEnd);
        if (eIdx >= 0 && endContainerRef.current) {
          scrollWheelToIndex(endContainerRef.current, eIdx, true);
        }
      }
    }
  };

  const handleSelectEnd = (h, shouldScroll = true) => {
    if (h <= startH) return;
    const formatted = `${h.toString().padStart(2, '0')}:00`;
    setEndTime(formatted);
    if (shouldScroll) {
      const eIdx = END_HOURS.indexOf(h);
      if (eIdx >= 0 && endContainerRef.current) {
        scrollWheelToIndex(endContainerRef.current, eIdx, true);
      }
    }
  };

  const applyPreset = (s, e) => {
    isProgrammaticRef.current = true;
    if (programmaticTimerRef.current) {
      clearTimeout(programmaticTimerRef.current);
    }
    setStartTime(s);
    setEndTime(e);
    const newStartH = parseInt(s.split(':')[0], 10);
    const newEndH = parseInt(e.split(':')[0], 10);
    const sIdx = START_HOURS.indexOf(newStartH);
    const eIdx = END_HOURS.indexOf(newEndH);
    if (sIdx >= 0 && startContainerRef.current) {
      scrollWheelToIndex(startContainerRef.current, sIdx, true);
    }
    if (eIdx >= 0 && endContainerRef.current) {
      scrollWheelToIndex(endContainerRef.current, eIdx, true);
    }
    programmaticTimerRef.current = setTimeout(() => {
      isProgrammaticRef.current = false;
    }, 450);
  };

  const stepStart = (delta) => {
    const currIdx = START_HOURS.indexOf(startH);
    const nextIdx = Math.max(0, Math.min(START_HOURS.length - 1, currIdx + delta));
    handleSelectStart(START_HOURS[nextIdx], true);
  };

  const stepEnd = (delta) => {
    const currIdx = END_HOURS.indexOf(endH);
    const nextIdx = Math.max(0, Math.min(END_HOURS.length - 1, currIdx + delta));
    if (END_HOURS[nextIdx] > startH) {
      handleSelectEnd(END_HOURS[nextIdx], true);
    }
  };

  // Debounced scroll listener for user touch/mouse wheel interactions
  const handleStartScroll = (e) => {
    if (isProgrammaticRef.current) return;
    if (startScrollTimerRef.current) clearTimeout(startScrollTimerRef.current);
    const target = e.currentTarget;
    startScrollTimerRef.current = setTimeout(() => {
      if (isProgrammaticRef.current) return;
      const st = target.scrollTop;
      const idx = Math.round(st / ITEM_HEIGHT);
      if (idx >= 0 && idx < START_HOURS.length) {
        const picked = START_HOURS[idx];
        if (picked !== startH) {
          handleSelectStart(picked, false);
        }
      }
    }, 120);
  };

  const handleEndScroll = (e) => {
    if (isProgrammaticRef.current) return;
    if (endScrollTimerRef.current) clearTimeout(endScrollTimerRef.current);
    const target = e.currentTarget;
    endScrollTimerRef.current = setTimeout(() => {
      if (isProgrammaticRef.current) return;
      const st = target.scrollTop;
      const idx = Math.round(st / ITEM_HEIGHT);
      if (idx >= 0 && idx < END_HOURS.length) {
        const picked = END_HOURS[idx];
        if (picked > startH && picked !== endH) {
          handleSelectEnd(picked, false);
        }
      }
    }, 120);
  };

  const durationHours = Math.max(0, endH - startH);

  return (
    <div className="space-y-3">
      {/* Preset Pills */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs font-bold text-[#7A7067] flex items-center gap-1">
            <Clock className="w-3.5 h-3.5 text-[#8B5B43]" />
            常用營業時段一鍵套用
          </label>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => applyPreset('13:00', '21:00')}
            className={`px-3 py-1.5 text-xs rounded-full border transition-all font-bold flex items-center gap-1 ${
              startTime === '13:00' && endTime === '21:00'
                ? 'bg-gray-900 text-white border-gray-900 shadow-sm'
                : 'bg-white text-gray-700 border-gray-200 hover:bg-amber-50 hover:border-amber-400'
            }`}
          >
            ☀️ 平日 (13:00~21:00)
          </button>
          <button
            type="button"
            onClick={() => applyPreset('09:00', '21:00')}
            className={`px-3 py-1.5 text-xs rounded-full border transition-all font-bold flex items-center gap-1 ${
              startTime === '09:00' && endTime === '21:00'
                ? 'bg-gray-900 text-white border-gray-900 shadow-sm'
                : 'bg-white text-gray-700 border-gray-200 hover:bg-amber-50 hover:border-amber-400'
            }`}
          >
            🌟 假日 (09:00~21:00)
          </button>
          <button
            type="button"
            onClick={() => applyPreset('10:00', '22:00')}
            className={`px-3 py-1.5 text-xs rounded-full border transition-all font-bold flex items-center gap-1 ${
              startTime === '10:00' && endTime === '22:00'
                ? 'bg-gray-900 text-white border-gray-900 shadow-sm'
                : 'bg-white text-gray-700 border-gray-200 hover:bg-amber-50 hover:border-amber-400'
            }`}
          >
            ⏰ 全天 (10:00~22:00)
          </button>
        </div>
      </div>

      {/* Double Column Scroll Wheels */}
      <div className="bg-[#FAF7F2] border border-[#E8DEC8] rounded-2xl p-3 shadow-2xs">
        <div className="grid grid-cols-2 gap-2 relative items-center">
          {/* Start Hour Column */}
          <div className="flex flex-col items-center">
            <div className="text-[11px] font-bold text-[#8B5B43] mb-1 flex items-center justify-between w-full px-2">
              <span>開始整點</span>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => stepStart(-1)}
                  disabled={startH <= START_HOURS[0]}
                  className="p-0.5 rounded text-[#7A7067] hover:text-[#3E332B] hover:bg-white/80 disabled:opacity-20"
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => stepStart(1)}
                  disabled={startH >= START_HOURS[START_HOURS.length - 1]}
                  className="p-0.5 rounded text-[#7A7067] hover:text-[#3E332B] hover:bg-white/80 disabled:opacity-20"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="relative w-full h-[160px] bg-white rounded-xl border border-[#E5DFD7] overflow-hidden select-none">
              {/* Highlight selection band (centered at 60px..100px) */}
              <div className="absolute top-[60px] left-1 right-1 h-[40px] border-y-2 border-[#8B5B43]/50 bg-[#FAF4EB]/80 rounded-lg pointer-events-none z-0" />
              {/* Top gradient fade */}
              <div className="absolute top-0 left-0 right-0 h-[60px] bg-gradient-to-b from-white via-white/85 to-transparent pointer-events-none z-10" />
              {/* Bottom gradient fade */}
              <div className="absolute bottom-0 left-0 right-0 h-[60px] bg-gradient-to-t from-white via-white/85 to-transparent pointer-events-none z-10" />

              {/* Scrollable list */}
              <div
                ref={startContainerRef}
                className="h-full overflow-y-auto snap-y snap-mandatory pt-[60px] pb-[60px] no-scrollbar scroll-smooth relative z-5"
                onScroll={handleStartScroll}
              >
                {START_HOURS.map((h) => {
                  const isSelected = h === startH;
                  return (
                    <div
                      key={h}
                      onClick={() => handleSelectStart(h, true)}
                      className={`h-[40px] snap-center flex items-center justify-center cursor-pointer transition-all ${
                        isSelected
                          ? 'text-[#8B5B43] font-bold text-base scale-105'
                          : 'text-[#9C8F84] text-xs hover:text-[#5C4E42]'
                      }`}
                    >
                      {h.toString().padStart(2, '0')}:00
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* End Hour Column */}
          <div className="flex flex-col items-center">
            <div className="text-[11px] font-bold text-[#8B5B43] mb-1 flex items-center justify-between w-full px-2">
              <span>結束整點</span>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => stepEnd(-1)}
                  disabled={endH <= startH + 1}
                  className="p-0.5 rounded text-[#7A7067] hover:text-[#3E332B] hover:bg-white/80 disabled:opacity-20"
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => stepEnd(1)}
                  disabled={endH >= END_HOURS[END_HOURS.length - 1]}
                  className="p-0.5 rounded text-[#7A7067] hover:text-[#3E332B] hover:bg-white/80 disabled:opacity-20"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="relative w-full h-[160px] bg-white rounded-xl border border-[#E5DFD7] overflow-hidden select-none">
              {/* Highlight selection band */}
              <div className="absolute top-[60px] left-1 right-1 h-[40px] border-y-2 border-[#8B5B43]/50 bg-[#FAF4EB]/80 rounded-lg pointer-events-none z-0" />
              {/* Top gradient fade */}
              <div className="absolute top-0 left-0 right-0 h-[60px] bg-gradient-to-b from-white via-white/85 to-transparent pointer-events-none z-10" />
              {/* Bottom gradient fade */}
              <div className="absolute bottom-0 left-0 right-0 h-[60px] bg-gradient-to-t from-white via-white/85 to-transparent pointer-events-none z-10" />

              {/* Scrollable list */}
              <div
                ref={endContainerRef}
                className="h-full overflow-y-auto snap-y snap-mandatory pt-[60px] pb-[60px] no-scrollbar scroll-smooth relative z-5"
                onScroll={handleEndScroll}
              >
                {END_HOURS.map((h) => {
                  const isSelected = h === endH;
                  const isDisabled = h <= startH;
                  return (
                    <div
                      key={h}
                      onClick={() => !isDisabled && handleSelectEnd(h, true)}
                      className={`h-[40px] snap-center flex items-center justify-center transition-all ${
                        isDisabled
                          ? 'text-gray-300 opacity-20 cursor-not-allowed pointer-events-none'
                          : isSelected
                          ? 'text-[#8B5B43] font-bold text-base scale-105 cursor-pointer'
                          : 'text-[#9C8F84] text-xs hover:text-[#5C4E42] cursor-pointer'
                      }`}
                    >
                      {h.toString().padStart(2, '0')}:00
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Range Duration Pill */}
        <div className="mt-2.5 pt-2 border-t border-[#E8DEC8]/60 flex items-center justify-between text-xs">
          <span className="text-[#7A7067] font-medium flex items-center gap-1">
            <span>時段範圍：</span>
            <strong className="text-[#3E332B]">{startTime} ~ {endTime}</strong>
          </span>
          <span className="bg-[#8B5B43] text-white px-2 py-0.5 rounded-full font-bold text-[11px] shadow-2xs">
            共 {durationHours} 小時 ({durationHours} 個時段)
          </span>
        </div>
      </div>
    </div>
  );
}
