import { createContext, useContext } from 'react';

export const FLOOR_OFFLINE_MSG = '連線中斷中，暫時不能操作';

export const FloorOfflineContext = createContext({
  offline: false,
  reason: FLOOR_OFFLINE_MSG
});

export function useFloorOffline() {
  return useContext(FloorOfflineContext);
}
