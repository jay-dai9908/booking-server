import React from 'react';
import { Printer } from 'lucide-react';

export default function PrinterStatusLine({
  printer = { online: false, state: 'not_found', label: '離線' },
  onClick = null,
  className = ''
}) {
  const isOnline = Boolean(printer?.online);
  const isOk = printer?.state === 'ok';

  let dotColor = 'bg-sg-muted';
  if (isOnline && isOk) {
    dotColor = 'bg-sg-sage';
  } else if (isOnline && !isOk) {
    dotColor = 'bg-sg-peach animate-pulse';
  }

  const content = (
    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] bg-sg-paper border border-sg-line select-none ${className}`}>
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
      <Printer className="w-3.5 h-3.5 text-sg-muted flex-shrink-0" />
      <span className="text-sg-ink font-medium">{printer?.label || '商米印表機'}</span>
    </div>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="text-left hover:opacity-85 transition">
        {content}
      </button>
    );
  }

  return content;
}
