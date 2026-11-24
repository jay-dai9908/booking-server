import React from 'react';

export default function AlertList({
  alerts = [],
  onSelectAlert,
  onMarkNoShow,
  onMarkLeftAll,
  disabled = false,
  disabledMessage = '連線中斷中，暫時不能操作'
}) {
  if (!alerts || alerts.length === 0) return null;

  return (
    <div className="space-y-2">
      {alerts.map((al, idx) => (
        <div
          key={`${al.booking_ref || 'alert'}-${al.seat_code || idx}`}
          onClick={() => onSelectAlert?.(al)}
          className="p-2.5 rounded-2xl bg-white border border-sg-line cursor-pointer hover:border-sg-brown text-[12px] space-y-1"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="font-bold text-sg-ink truncate">{al.title || al.text}</div>
            {al.action === 'mark_no_show' && (
              <button
                type="button"
                disabled={disabled}
                title={disabled ? disabledMessage : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  if (disabled) return;
                  onMarkNoShow?.(al.booking_ref);
                }}
                className={`px-2 py-0.5 rounded-lg font-bold text-[11px] transition shrink-0 ${
                  disabled
                    ? 'bg-gray-100 text-sg-muted cursor-not-allowed opacity-60'
                    : 'bg-sg-danger-soft text-sg-danger hover:bg-sg-danger hover:text-white'
                }`}
              >
                標記未到
              </button>
            )}
            {al.action === 'mark_left_all' && (
              <button
                type="button"
                disabled={disabled}
                title={disabled ? disabledMessage : undefined}
                data-testid={`alert-leave-btn-${al.booking_ref}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (disabled) return;
                  onMarkLeftAll?.(al.booking_ref);
                }}
                className={`px-2 py-0.5 rounded-lg font-bold text-[11px] transition shrink-0 ${
                  disabled
                    ? 'bg-gray-100 text-sg-muted cursor-not-allowed opacity-60'
                    : 'bg-sg-peach-soft text-sg-peach-ink hover:bg-sg-peach hover:text-sg-ink'
                }`}
              >
                已離場
              </button>
            )}
          </div>
          {(al.subtitle || al.hint) && (
            <div className="text-sg-muted">{al.subtitle || al.hint}</div>
          )}
        </div>
      ))}
    </div>
  );
}
