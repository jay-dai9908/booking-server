import React, { useEffect } from 'react';
import '../../styles/customer.css';
import ErrorBoundary from '../common/ErrorBoundary';
import { useToast } from './Toast';

export default function CustomerLayout({
  header,
  bottom,
  children,
  bare = false,
  mainClassName = '',
}) {
  const { show } = useToast();

  useEffect(() => {
    const origBg = document.body.style.backgroundColor;
    document.body.style.backgroundColor = '#F6F1EA';
    return () => {
      document.body.style.backgroundColor = origBg;
    };
  }, []);

  useEffect(() => {
    const handleSgToast = (e) => {
      if (e.detail?.message && show) {
        show(e.detail.message, e.detail.options || { type: e.detail.type || 'error' });
      }
    };
    window.addEventListener('sg-toast', handleSgToast);
    return () => {
      window.removeEventListener('sg-toast', handleSgToast);
    };
  }, [show]);

  return (
    <div className="sg-app min-h-[100dvh] bg-sg-bg font-body text-sg-ink antialiased overflow-x-clip">
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[480px] flex-col overflow-x-clip">
        {header}
        <main
          className={`flex flex-1 flex-col gap-3 [&>*]:shrink-0 ${
            bare
              ? ''
              : 'px-[max(16px,env(safe-area-inset-left))] pr-[max(16px,env(safe-area-inset-right))] pt-[14px] pb-5'
          } ${mainClassName}`}
        >
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
        </main>
        {bottom && <div className="sticky bottom-0 z-40">{bottom}</div>}
      </div>
    </div>
  );
}

