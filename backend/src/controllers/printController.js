import crypto from 'crypto';
import prisma from '../prismaClient.js';
import { queuePrintJob, claimNextJob, reportJobResult } from '../services/print/printService.js';
import { getAdminDeviceInfo } from '../utils/deviceParser.js';

// Station endpoints (called by Sunmi App via verifyPrintStation)
export async function stationHeartbeat(req, res) {
  const station = req.printStation;
  const { printer_state, printer_message, app_version, device_model } = req.body;

  try {
    const updated = await prisma.printStation.update({
      where: { id: station.id },
      data: {
        last_seen_at: new Date(),
        printer_state: printer_state || 'ok',
        printer_message: printer_message || null,
        app_version: app_version || station.app_version,
        device_model: device_model || station.device_model
      }
    });

    return res.json({
      accepting: updated.accepting,
      server_now: new Date().toISOString(),
      poll: { wait_seconds: 20 }
    });
  } catch (error) {
    console.error('[stationHeartbeat] Error:', error);
    return res.status(500).json({ error: '心跳更新失敗' });
  }
}

export async function stationClaim(req, res) {
  const station = req.printStation;
  const waitSeconds = Math.min(30, Math.max(0, parseInt(req.query.wait || '20', 10)));

  try {
    const job = await claimNextJob(station.id, waitSeconds);
    return res.json({
      server_now: new Date().toISOString(),
      job: job || null
    });
  } catch (error) {
    console.error('[stationClaim] Error:', error);
    return res.status(500).json({ error: '領取單據失敗' });
  }
}

export async function stationReportResult(req, res) {
  const { id } = req.params;
  const { success, error_code, error_message } = req.body;

  try {
    const job = await reportJobResult(id, { success, error_code, error_message }, 'station');
    return res.json({ success: true, job });
  } catch (error) {
    console.error('[stationReportResult] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '回報結果失敗' });
  }
}

// Admin endpoints
export async function getStatus(req, res) {
  try {
    const station = await prisma.printStation.findFirst({
      where: { is_active: true, is_default: true }
    });

    if (!station) {
      return res.json({ station: null });
    }

    const now = Date.now();
    const isOnline = station.last_seen_at && (now - new Date(station.last_seen_at).getTime()) <= 75000;

    const queuedCount = await prisma.printJob.count({ where: { status: 'queued' } });
    const failedCount = await prisma.printJob.count({ where: { status: 'failed' } });

    return res.json({
      station: {
        id: station.id,
        name: station.name,
        online: Boolean(isOnline),
        state: isOnline ? (station.printer_state || 'ok') : 'offline',
        message: station.printer_message,
        last_seen_at: station.last_seen_at,
        accepting: station.accepting,
        queued: queuedCount,
        failed: failedCount
      }
    });
  } catch (error) {
    console.error('[getStatus] Error:', error);
    return res.status(500).json({ error: '無法讀取列印站狀態' });
  }
}

export async function createJob(req, res) {
  const staffUser = req.user;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const job = await queuePrintJob({
      ...req.body,
      user: staffUser,
      device: deviceInfo
    });

    return res.json({ success: true, job });
  } catch (error) {
    console.error('[createJob] Error:', error);
    return res.status(500).json({ error: '建立列印單失敗', details: error.message });
  }
}

export async function getJobById(req, res) {
  const { id } = req.params;
  try {
    const job = await prisma.printJob.findUnique({ where: { id: Number(id) } });
    if (!job) return res.status(404).json({ error: '找不到該列印單' });
    return res.json(job);
  } catch (error) {
    console.error('[getJobById] Error:', error);
    return res.status(500).json({ error: '無法讀取列印單' });
  }
}

export async function listJobs(req, res) {
  const { status, date, booking_ref } = req.query;
  const where = {};
  if (status) where.status = status;
  if (booking_ref) where.booking_ref = booking_ref;
  if (date) {
    const start = new Date(`${date}T00:00:00+08:00`);
    const end = new Date(`${date}T23:59:59.999+08:00`);
    where.created_at = { gte: start, lte: end };
  }

  try {
    const jobs = await prisma.printJob.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 100
    });
    return res.json({ jobs });
  } catch (error) {
    console.error('[listJobs] Error:', error);
    return res.status(500).json({ error: '無法讀取列印紀錄' });
  }
}

export async function retryJob(req, res) {
  const { id } = req.params;
  try {
    const job = await prisma.printJob.findUnique({ where: { id: Number(id) } });
    if (!job) return res.status(404).json({ error: '找不到該列印單' });

    const updated = await prisma.printJob.update({
      where: { id: job.id },
      data: {
        status: 'queued',
        error_code: null,
        error_message: null,
        attempts: { increment: 1 }
      }
    });

    return res.json({ success: true, job: updated });
  } catch (error) {
    console.error('[retryJob] Error:', error);
    return res.status(500).json({ error: '重試列印單失敗' });
  }
}

export async function cancelJob(req, res) {
  const { id } = req.params;
  try {
    const updated = await prisma.printJob.update({
      where: { id: Number(id) },
      data: { status: 'cancelled' }
    });
    return res.json({ success: true, job: updated });
  } catch (error) {
    console.error('[cancelJob] Error:', error);
    return res.status(500).json({ error: '取消列印單失敗' });
  }
}

export async function reportLocalJob(req, res) {
  const { id } = req.params;
  const { result, via = 'browser', error } = req.body;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const updated = await reportJobResult(
      id,
      {
        success: result === 'printed',
        error_message: error
      },
      `${via}:${deviceInfo.device_label}`
    );
    return res.json({ success: true, job: updated });
  } catch (error) {
    console.error('[reportLocalJob] Error:', error);
    return res.status(500).json({ error: '回報本機列印結果失敗' });
  }
}

export async function getStations(req, res) {
  try {
    const stations = await prisma.printStation.findMany({
      orderBy: { created_at: 'desc' }
    });
    return res.json({ stations });
  } catch (error) {
    console.error('[getStations] Error:', error);
    return res.status(500).json({ error: '無法讀取列印站列表' });
  }
}

export async function updateStation(req, res) {
  const { id } = req.params;
  const { name, accepting, is_active } = req.body;
  try {
    const updated = await prisma.printStation.update({
      where: { id: Number(id) },
      data: {
        ...(name !== undefined && { name: String(name).trim() }),
        ...(accepting !== undefined && { accepting: Boolean(accepting) }),
        ...(is_active !== undefined && { is_active: Boolean(is_active) })
      }
    });
    return res.json({ success: true, station: updated });
  } catch (error) {
    console.error('[updateStation] Error:', error);
    return res.status(500).json({ error: '更新列印站失敗' });
  }
}

export async function pairStation(req, res) {
  const { name = '櫃檯商米' } = req.body;
  const staffName = req.user?.name || '管理員';

  try {
    const rawSecret = crypto.randomBytes(32).toString('base64url');
    const secretHash = crypto.createHash('sha256').update(rawSecret).digest('hex');

    // Deactivate existing default if any
    await prisma.printStation.updateMany({
      where: { is_default: true },
      data: { is_default: false }
    });

    const station = await prisma.printStation.create({
      data: {
        name: String(name).trim(),
        secret_hash: secretHash,
        is_active: true,
        is_default: true,
        paired_by_name: staffName
      }
    });

    return res.json({
      success: true,
      station_id: station.id,
      secret: rawSecret
    });
  } catch (error) {
    console.error('[pairStation] Error:', error);
    return res.status(500).json({ error: '配對列印站失敗' });
  }
}

export async function unpairStation(req, res) {
  const { id } = req.params;
  try {
    await prisma.printStation.update({
      where: { id: Number(id) },
      data: { is_active: false, accepting: false }
    });
    return res.json({ success: true });
  } catch (error) {
    console.error('[unpairStation] Error:', error);
    return res.status(500).json({ error: '解除配對失敗' });
  }
}

export async function testStation(req, res) {
  const { id } = req.params;
  const deviceInfo = getAdminDeviceInfo(req);
  try {
    const station = await prisma.printStation.findUnique({ where: { id: Number(id) } });
    if (!station) return res.status(404).json({ error: '找不到列印站' });

    const job = await queuePrintJob({
      type: 'test',
      user: req.user,
      device: deviceInfo,
      opts: { station_id: station.id }
    });

    return res.json({ success: true, job });
  } catch (error) {
    console.error('[testStation] Error:', error);
    return res.status(500).json({ error: '建立測試頁失敗' });
  }
}

export default {
  stationHeartbeat,
  stationClaim,
  stationReportResult,
  getStatus,
  createJob,
  getJobById,
  listJobs,
  retryJob,
  cancelJob,
  reportLocalJob,
  getStations,
  updateStation,
  pairStation,
  unpairStation,
  testStation
};
