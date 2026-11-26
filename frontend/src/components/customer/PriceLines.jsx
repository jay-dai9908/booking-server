import React from 'react';
import { KV } from './Card.jsx';
import { formatMoney, formatMinus } from '../../utils/customer/format.js';

export default function PriceLines({ lines = [], className = '' }) {
  if (!lines || lines.length === 0) return null;

  return (
    <div className={`grid gap-[8px] w-full ${className}`}>
      {lines.map((line, idx) => {
        const isSave = line.tone === 'save' || line.amount < 0;
        const formattedAmount = isSave
          ? formatMinus(Math.abs(line.amount))
          : formatMoney(line.amount);

        return (
          <KV
            key={idx}
            label={line.label}
            tone={isSave ? 'save' : undefined}
            value={
              <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 justify-end">
                <span className="font-num tabular-nums">{formattedAmount}</span>
                {line.note && (
                  <span className="font-body text-[12px] text-sg-muted font-normal">
                    （{line.note}）
                  </span>
                )}
              </div>
            }
          />
        );
      })}
    </div>
  );
}
