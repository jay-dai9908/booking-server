export const getBrowserClientInfo = () => {
  if (typeof window === 'undefined') return {};
  const conn = navigator?.connection || navigator?.mozConnection || navigator?.webkitConnection;
  return {
    screenWidth: window.screen?.width || window.innerWidth || 0,
    screenHeight: window.screen?.height || window.innerHeight || 0,
    pixelRatio: window.devicePixelRatio || 1,
    language: navigator?.language || '',
    networkType: conn?.effectiveType || conn?.type || ''
  };
};
