import React, { useEffect } from 'react';
import '../../styles/customer.css';
import { ToastProvider } from './Toast.jsx';

export default function CustomerLayout({
  header,
  bottom,
  children,
  bare = false,
  mainClassName = '',
}) {
  useEffect(() => {
    const origBg = document.body.style.backgroundColor;
    document.body.style.backgroundColor = '#F6F1EA';
    return () => {
      document.body.style.backgroundColor = origBg;
    };
  }, []);

  return (
    <ToastProvider>
      <div className="sg-app min-h-[100dvh] bg-sg-bg font-body text-sg-ink antialiased">
        <div className="mx-auto flex min-h-[100dvh] w-full max-w-[480px] flex-col">
          {header}
          <main
            className={`flex flex-1 flex-col gap-3 [&>*]:shrink-0 ${
              bare
                ? ''
                : 'px-[max(16px,env(safe-area-inset-left))] pr-[max(16px,env(safe-area-inset-right))] pt-[14px] pb-5'
            } ${mainClassName}`}
          >
            {children}
          </main>
          {bottom && <div className="sticky bottom-0 z-40">{bottom}</div>}
        </div>
      </div>
    </ToastProvider>
  );
}
