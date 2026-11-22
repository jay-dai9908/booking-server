import prisma from '../prismaClient.js';
import { getClientIp } from '../utils/deviceParser.js';
import { buildDisplayState } from '../services/display/stateService.js';
import displayBus from '../services/display/displayBus.js';

// Register state provider for SSE floorChanged / settingsChanged broadcasts
displayBus.setDisplayStateProvider(() => buildDisplayState(new Date()));

export async function getDisplayStateHandler(req, res) {
  try {
    const state = await buildDisplayState(new Date());
    return res.json(state);
  } catch (err) {
    console.error('[displayState] getDisplayStateHandler error:', err.message);
    return res.status(500).json({ error: '無法取得顯示屏狀態' });
  }
}

export async function streamDisplayHandler(req, res) {
  const device = req.displayDevice;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let closed = false;

  const sendRaw = (chunk) => {
    if (closed || res.writableEnded) return;
    res.write(chunk);
  };

  const sendEvent = (eventName, payload) => {
    sendRaw(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const closeStream = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeatTimer);
    clearInterval(stateTimer);
    unsubscribe();
    if (!res.writableEnded) {
      res.end();
    }
  };

  const client = {
    deviceId: device.id,
    tokenVersion: device.token_version,
    sendEvent,
    close: closeStream
  };

  const unsubscribe = displayBus.subscribeDisplayClient(client);

  // Send immediate state on connect (and active checkout / message if any)
  try {
    const initialState = await buildDisplayState(new Date());
    sendEvent('state', initialState);
    const activeCo = displayBus.getActiveCheckout();
    if (activeCo) {
      sendEvent('checkout', activeCo);
    }
    const activeMsg = displayBus.getActiveMessage();
    if (activeMsg) {
      sendEvent('message', activeMsg);
    }
  } catch (err) {
    console.error('[displayState] initial SSE state error:', err.message);
  }

  // 15s SSE comment heartbeat
  const heartbeatTimer = setInterval(() => {
    sendRaw(': heartbeat\n\n');
  }, 15 * 1000);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  // 30s periodic state + token_version check
  const stateTimer = setInterval(async () => {
    if (closed) return;
    try {
      const dbDev = await prisma.displayDevice.findUnique({
        where: { id: device.id },
        select: { token_version: true }
      });
      if (!dbDev || dbDev.token_version !== client.tokenVersion) {
        sendEvent('logout', { error: 'DISPLAY_LOGGED_OUT' });
        closeStream();
        return;
      }
      const nextState = await buildDisplayState(new Date());
      sendEvent('state', nextState);
    } catch (err) {
      console.error('[displayState] periodic SSE state error:', err.message);
    }
  }, 30 * 1000);
  if (stateTimer.unref) stateTimer.unref();

  req.on('close', closeStream);
  req.on('error', closeStream);
}

export async function postDisplayHeartbeat(req, res) {
  const device = req.displayDevice;
  const { current_view } = req.body || {};
  const cleanView = typeof current_view === 'string' ? current_view.trim().slice(0, 64) : null;
  const ip = getClientIp(req);

  try {
    await prisma.displayDevice.update({
      where: { id: device.id },
      data: {
        last_seen_at: new Date(),
        last_ip: ip,
        ...(cleanView !== null ? { current_view: cleanView } : {})
      }
    });
    return res.json({ ok: true, server_now: new Date().toISOString() });
  } catch (err) {
    console.error('[displayState] postDisplayHeartbeat error:', err.message);
    return res.status(500).json({ error: '心跳回報失敗' });
  }
}

export async function reloadAdminDevice(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '無效的裝置編號' });
  }

  try {
    const existing = await prisma.displayDevice.findUnique({
      where: { id },
      select: { id: true }
    });
    if (!existing) {
      return res.status(404).json({ error: '找不到顯示屏裝置' });
    }

    displayBus.reloadDevice(id);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[displayState] reloadAdminDevice error:', err.message);
    return res.status(500).json({ error: '送出重新整理指令失敗' });
  }
}
