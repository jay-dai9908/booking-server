import React from 'react';

export function Bead({
  size = 10,
  bw,
  color,
  empty = false,
  className = '',
  style = {},
}) {
  const calculatedBw = bw !== undefined ? bw : Math.max(2, Math.round(size * 0.29));
  const beadColor = empty ? undefined : color;

  return (
    <span
      className={`sg-bead ${empty ? 'sg-bead-empty' : ''} ${className}`}
      style={{
        '--sg-bead-size': `${size}px`,
        '--sg-bead-bw': `${calculatedBw}px`,
        ...(beadColor ? { '--sg-bead-color': beadColor } : {}),
        ...style,
      }}
      aria-hidden="true"
    />
  );
}

export function BeadMeter({ count = 0, state = 'ok', isSelected = false, className = '' }) {
  const litColor = isSelected
    ? '#FFFFFF'
    : state === 'ok'
    ? '#7E9A72'
    : state === 'low'
    ? '#D9A441'
    : '#C9BFB4';

  const emptyColor = isSelected ? 'rgba(255, 255, 255, 0.35)' : undefined;

  return (
    <div className={`flex items-center gap-[3px] h-[10px] mt-[2px] ${className}`} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => {
        const isLit = i < count && state !== 'full' && state !== 'past';
        return (
          <Bead
            key={i}
            size={9}
            bw={2.5}
            empty={!isLit}
            color={isLit ? litColor : undefined}
            style={!isLit && emptyColor ? { '--sg-bead-color': emptyColor } : {}}
          />
        );
      })}
    </div>
  );
}

export function BeadLoader({ size = 'md', className = '' }) {
  const isSm = size === 'sm';
  const beadSize = isSm ? 8 : 18;
  const beadBw = isSm ? 2.5 : 5;
  const gap = isSm ? 'gap-1' : 'gap-2';
  const colors = isSm
    ? ['#FFFFFF', '#FFFFFF', '#FFFFFF', '#FFFFFF', '#FFFFFF']
    : ['#8B5B43', '#E7B4A2', '#7E9A72', '#D9A441', '#E6DDD2'];

  return (
    <div
      role="status"
      className={`inline-flex items-center ${gap} ${className}`}
      aria-label="載入中"
    >
      <span className="sr-only">載入中</span>
      {colors.map((c, i) => (
        <span
          key={i}
          className="animate-bead-bounce inline-block"
          style={{ animationDelay: `${i * 0.2}s` }}
        >
          <Bead
            size={beadSize}
            bw={beadBw}
            color={c}
            empty={i === 4 && !isSm}
          />
        </span>
      ))}
    </div>
  );
}

export function BeadRow({ className = '', count = 5, size = 12, gap = 4 }) {
  const colors = ['#8B5B43', '#E7B4A2', '#7E9A72', '#D9A441', '#E6DDD2'];
  return (
    <div
      className={`inline-flex items-center max-w-full overflow-hidden ${className}`}
      style={{ gap: `${gap}px` }}
      aria-hidden="true"
    >
      {Array.from({ length: count }).map((_, i) => (
        <Bead
          key={i}
          size={size}
          color={colors[i % colors.length]}
          empty={i % colors.length === 4}
        />
      ))}
    </div>
  );
}

export default Bead;
