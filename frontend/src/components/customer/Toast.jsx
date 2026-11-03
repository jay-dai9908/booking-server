import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { Info, Check, AlertCircle } from 'lucide-react';

const ToastContext = createContext({
  show: () => {},
});

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }) {
  const [current, setCurrent] = useState(null);
  const queueRef = useRef([]);
  const timerRef = useRef(null);

  const processQueue = useCallback(() => {
    if (queueRef.current.length === 0) {
      setCurrent(null);
      return;
    }
    const next = queueRef.current.shift();
    setCurrent(next);

    const duration = next.type === 'error' ? 5000 : 3000;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      processQueue();
    }, duration);
  }, []);

  const show = useCallback(
    (message, options = {}) => {
      const item = {
        id: Math.random().toString(36).substring(2, 9),
        message,
        type: options.type || 'info',
      };
      if (!current) {
        setCurrent(item);
        const duration = item.type === 'error' ? 5000 : 3000;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          processQueue();
        }, duration);
      } else {
        queueRef.current.push(item);
      }
    },
    [current, processQueue]
  );

  const dismiss = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    processQueue();
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {current && (
        <div
          role={current.type === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          onClick={dismiss}
          className="fixed left-1/2 -translate-x-1/2 z-[60] bottom-[calc(env(safe-area-inset-bottom)+96px)] w-[calc(100%-32px)] max-w-[448px] rounded-[14px] bg-sg-ink/95 text-white text-[14px] leading-[1.5] px-[14px] py-[10px] shadow-[0_8px_24px_rgba(42,35,30,0.25)] flex items-start gap-2 cursor-pointer animate-fade-in select-none"
        >
          <span className="shrink-0 pt-[2px]">
            {current.type === 'success' && <Check className="w-[18px] h-[18px] text-white" strokeWidth={2} />}
            {current.type === 'error' && <AlertCircle className="w-[18px] h-[18px] text-white" strokeWidth={2} />}
            {current.type === 'info' && <Info className="w-[18px] h-[18px] text-white" strokeWidth={2} />}
          </span>
          <div className="flex-1 break-words">{current.message}</div>
        </div>
      )}
    </ToastContext.Provider>
  );
}

export default ToastProvider;
