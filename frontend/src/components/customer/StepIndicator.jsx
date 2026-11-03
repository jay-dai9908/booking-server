import React from 'react';

export default function StepIndicator({
  steps = ['日期', '時段', '人數', '確認'],
  currentStep = 1, // 0-indexed, step name, 'all', or 'none' / -1
  className = '',
}) {
  const isAll = currentStep === 'all';
  const isNone = currentStep === 'none' || currentStep < 0;

  let currentIndex = -1;
  if (!isNone) {
    if (typeof currentStep === 'number') {
      currentIndex = Math.min(steps.length - 1, Math.max(0, currentStep));
    } else if (typeof currentStep === 'string' && !isAll) {
      const found = steps.indexOf(currentStep);
      currentIndex = found >= 0 ? found : 0;
    } else if (isAll) {
      currentIndex = steps.length;
    }
  }

  const ariaText = isNone
    ? '已取消'
    : isAll
    ? '已完成全部步驟'
    : `步驟 ${currentIndex + 1}／${steps.length}：${steps[currentIndex] || ''}`;

  return (
    <div
      role="group"
      aria-label={ariaText}
      className={`flex items-center justify-between w-full px-2 py-1 select-none ${className}`}
    >
      {steps.map((label, idx) => {
        const isCurrent = !isAll && !isNone && idx === currentIndex;
        const isCompleted = isAll ? true : (!isNone && idx < currentIndex);
        const isLineActive = !isNone && (idx <= currentIndex);

        let dotRingColor = '#E6DDD2'; // sg-line
        let dotShadow = 'none';

        if (isCompleted) {
          dotRingColor = '#8B5B43'; // sg-brown
        } else if (isCurrent) {
          dotRingColor = '#E7B4A2'; // sg-peach
          dotShadow = '0 0 0 3px #F7E3DA';
        }

        return (
          <React.Fragment key={idx}>
            {idx > 0 && (
              <div
                className={`flex-1 h-[2px] mb-[18px] transition-colors duration-200 ${
                  isLineActive ? 'bg-sg-brown' : 'bg-sg-line'
                }`}
                aria-hidden="true"
              />
            )}
            <div className="grid justify-items-center gap-1 w-[46px] flex-none text-center">
              <div
                className="h-4 w-4 rounded-full transition-all duration-200"
                style={{
                  background: `radial-gradient(circle, #FFFDF9 0 26%, ${dotRingColor} 29%)`,
                  boxShadow: dotShadow,
                }}
                aria-hidden="true"
              />
              <span
                className={`text-[12px] leading-tight ${
                  isCurrent ? 'text-sg-ink font-bold' : 'text-sg-muted'
                }`}
              >
                {label}
              </span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}
