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
            value={<span className="font-num tabular-nums">{formattedAmount}</span>}
          />
        );
      })}
    </div>
  );
}
