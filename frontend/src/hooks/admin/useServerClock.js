import { useState, useEffect, useRef } from 'react';

export function useServerClock(initialServerNow = null) {
  // offsetMs = server_time - client_time
  const [offsetMs, setOffsetMs] = useState(0);

  const syncWithServerNow = (serverNowStr) => {
    if (!serverNowStr) return;
    const serverTime = new Date(serverNowStr).getTime();
    const clientTime = Date.now();
    setOffsetMs(serverTime - clientTime);
  };

  useEffect(() => {
    if (initialServerNow) {
      syncWithServerNow(initialServerNow);
    }
  }, [initialServerNow]);

  const getServerNow = () => {
    return new Date(Date.now() + offsetMs);
  };

  return {
    offsetMs,
    syncWithServerNow,
    getServerNow
  };
}

export default useServerClock;
