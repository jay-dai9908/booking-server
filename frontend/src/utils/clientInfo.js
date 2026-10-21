const PUBLIC_IP_CACHE_KEY = 'shiguang_client_public_ip';
let inflightIpPromise = null;

const fetchPublicIpOnce = () => {
  if (typeof window === 'undefined') return Promise.resolve('');
  try {
    const cached = sessionStorage.getItem(PUBLIC_IP_CACHE_KEY);
    if (cached) return Promise.resolve(cached);
  } catch (e) {}

  if (inflightIpPromise) return inflightIpPromise;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = setTimeout(() => {
    try {
      controller?.abort();
    } catch (e) {}
  }, 1500);

  inflightIpPromise = fetch('https://api.ipify.org?format=json', {
    signal: controller?.signal
  })
    .then(res => res.json())
    .then(data => {
      const ip = data?.ip ? String(data.ip).trim() : '';
      if (ip) {
        try {
          sessionStorage.setItem(PUBLIC_IP_CACHE_KEY, ip);
        } catch (e) {}
      }
      return ip;
    })
    .catch(() => '')
    .finally(() => {
      clearTimeout(timeoutId);
      inflightIpPromise = null;
    });

  return inflightIpPromise;
};

// Warm up IP cache immediately on module load
if (typeof window !== 'undefined') {
  fetchPublicIpOnce();
}

export const getBrowserClientInfo = () => {
  if (typeof window === 'undefined') return {};
  const conn = navigator?.connection || navigator?.mozConnection || navigator?.webkitConnection;
  let publicIp = '';
  try {
    publicIp = sessionStorage.getItem(PUBLIC_IP_CACHE_KEY) || '';
  } catch (e) {}

  return {
    screenWidth: window.screen?.width || window.innerWidth || 0,
    screenHeight: window.screen?.height || window.innerHeight || 0,
    pixelRatio: window.devicePixelRatio || 1,
    language: navigator?.language || '',
    networkType: conn?.effectiveType || conn?.type || '',
    publicIp
  };
};

export const getBrowserClientInfoAsync = async () => {
  const publicIp = await fetchPublicIpOnce();
  return {
    ...getBrowserClientInfo(),
    publicIp
  };
};
