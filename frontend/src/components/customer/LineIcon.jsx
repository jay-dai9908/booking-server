import React from 'react';

export default function LineIcon({ className = 'w-5 h-5' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12 3C6.5 3 2 6.6 2 11c0 3.9 3.5 7.2 8.3 7.9.3.1.8.2.9.5.1.3.1.7 0 1l-.1.9c-.1.3-.2 1 .9.5 1.1-.5 5.9-3.5 8-5.9C21.5 14.3 22 12.7 22 11c0-4.4-4.5-8-10-8z" />
    </svg>
  );
}
