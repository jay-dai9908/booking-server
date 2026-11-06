import React from 'react';

export default function SegmentedTabs({
  tabs = [], // [{ id: 'list', label: '名單', icon?: ReactNode, badge?: string|number }]
  activeId,
  activeTab,
  onChange,
  className = ''
}) {
  const currentActive = activeId !== undefined ? activeId : activeTab;

  return (
    <div
      className={`inline-flex items-center p-1 bg-sg-paper border border-sg-line rounded-full select-none ${className}`}
      role="tablist"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === currentActive;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-testid={tab['data-testid'] || `tab-${tab.id}`}
            onClick={() => onChange(tab.id)}
            className={`relative flex items-center justify-center min-h-[36px] px-3.5 sm:px-4 rounded-full text-[13px] font-bold transition-all duration-150 ${
              isActive
                ? 'bg-white text-sg-ink shadow-sm'
                : 'text-sg-muted hover:text-sg-ink'
            }`}
          >
            {tab.icon && <span className="mr-1.5 flex-shrink-0">{tab.icon}</span>}
            <span>{tab.label}</span>
            {tab.badge !== undefined && tab.badge !== null && (
              <span className={`ml-1.5 px-1.5 py-0.2 rounded-full text-[11px] font-bold ${
                isActive ? 'bg-sg-peach-soft text-sg-peach-ink' : 'bg-sg-line text-sg-muted'
              }`}>
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
