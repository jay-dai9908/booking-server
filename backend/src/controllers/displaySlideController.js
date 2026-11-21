import crypto from 'crypto';
import prisma from '../prismaClient.js';
import { inspectImageBuffer } from '../utils/imageInspect.js';
import displayBus from '../services/display/displayBus.js';

export const MAX_DISPLAY_SLIDE_BYTES = 2 * 1024 * 1024; // 2 MB
export const REQUIRED_SLIDE_WIDTH = 1920;
export const REQUIRED_SLIDE_HEIGHT = 1080;
const VALID_SETS = new Set(['self', 'general']);

function formatSlide(s) {
  return {
    id: s.id,
    set: s.set,
    title: s.title,
    sort_order: s.sort_order,
    seconds: s.seconds,
    enabled: s.enabled,
    mime: s.mime,
    sha256: s.sha256,
    url: `/api/display/files/slides/${s.id}/${s.sha256}`,
    created_at: s.created_at,
    updated_at: s.updated_at
  };
}

function decodeImageInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return null;
  let b64 = rawInput.trim();
  const dataUrlMatch = b64.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
  if (dataUrlMatch) {
    b64 = dataUrlMatch[1];
  }
  try {
    const buf = Buffer.from(b64, 'base64');
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

export async function listDisplaySlidesHandler(req, res) {
  try {
    const setFilter = req.query?.set ? String(req.query.set).trim() : null;
    if (setFilter && !VALID_SETS.has(setFilter)) {
      return res.status(422).json({ error: 'SLIDE_INVALID_SET', message: 'set 必須為 self 或 general' });
    }

    const slides = await prisma.displaySlide.findMany({
      where: setFilter ? { set: setFilter } : undefined,
      orderBy: [{ set: 'asc' }, { sort_order: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        set: true,
        title: true,
        sort_order: true,
        seconds: true,
        enabled: true,
        mime: true,
        sha256: true,
        created_at: true,
        updated_at: true
      }
    });

    return res.json({
      ok: true,
      slides: slides.map(formatSlide)
    });
  } catch (err) {
    console.error('[displaySlide] listDisplaySlidesHandler error:', err.message);
    return res.status(500).json({ error: '無法讀取顯示屏輪播圖' });
  }
}

export async function createDisplaySlideHandler(req, res) {
  try {
    let buffer = null;
    let set = 'self';
    let title = '輪播圖片';
    let seconds = 8;
    let enabled = true;

    if (Buffer.isBuffer(req.body)) {
      buffer = req.body;
      if (req.query.set !== undefined) set = String(req.query.set).trim();
      if (req.query.title) title = String(req.query.title).trim();
      if (req.query.seconds !== undefined) seconds = Number(req.query.seconds);
      if (req.query.enabled !== undefined) enabled = req.query.enabled === 'true';
    } else if (req.body && typeof req.body === 'object') {
      const b = req.body;
      if (b.set !== undefined) set = String(b.set).trim();
      if (b.title) title = String(b.title).trim();
      if (b.seconds !== undefined) seconds = Number(b.seconds);
      if (b.enabled !== undefined) enabled = Boolean(b.enabled);
      const rawB64 = b.data_base64 || b.raw_base64 || b.image_data_url || b.file_base64;
      buffer = decodeImageInput(rawB64);
    }

    if (!VALID_SETS.has(set)) {
      return res.status(422).json({ error: 'SLIDE_INVALID_SET', message: 'set 必須為 self 或 general' });
    }

    title = title.slice(0, 64) || '輪播圖片';

    if (!Number.isInteger(seconds) || seconds < 4 || seconds > 60) {
      return res.status(422).json({ error: 'SLIDE_INVALID_SECONDS', message: '每張停留秒數必須為 4 到 60 秒' });
    }

    if (!buffer || buffer.length === 0) {
      return res.status(422).json({ error: 'SLIDE_INVALID_IMAGE', message: '請提供有效的圖片檔案' });
    }

    if (buffer.length > MAX_DISPLAY_SLIDE_BYTES) {
      return res.status(422).json({
        error: 'SLIDE_TOO_LARGE',
        message: `輪播圖檔案不可超過 2 MB（目前 ${buffer.length} bytes）`
      });
    }

    const meta = inspectImageBuffer(buffer);
    if (!meta) {
      return res.status(422).json({
        error: 'SLIDE_INVALID_FORMAT',
        message: '輪播圖必須為 JPEG、PNG 或 WebP 格式'
      });
    }

    if (meta.width !== REQUIRED_SLIDE_WIDTH || meta.height !== REQUIRED_SLIDE_HEIGHT) {
      return res.status(422).json({
        error: 'SLIDE_INVALID_DIMENSIONS',
        message: `輪播圖尺寸必須為 ${REQUIRED_SLIDE_WIDTH}×${REQUIRED_SLIDE_HEIGHT}（目前為 ${meta.width}×${meta.height}）`
      });
    }

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const maxOrder = await prisma.displaySlide.aggregate({
      where: { set },
      _max: { sort_order: true }
    });
    const sortOrder = (maxOrder._max.sort_order ?? -1) + 1;

    const slide = await prisma.displaySlide.create({
      data: {
        set,
        title,
        sort_order: sortOrder,
        seconds,
        enabled,
        mime: meta.mime,
        sha256,
        bytes: buffer
      }
    });

    displayBus.settingsChanged();

    return res.status(201).json({
      ok: true,
      slide: {
        ...formatSlide(slide),
        size: buffer.length
      }
    });
  } catch (err) {
    console.error('[displaySlide] createDisplaySlideHandler error:', err.message);
    return res.status(500).json({ error: '上傳顯示屏輪播圖失敗' });
  }
}

export async function updateDisplaySlideHandler(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '無效的輪播圖編號' });
  }

  try {
    const existing = await prisma.displaySlide.findUnique({
      where: { id },
      select: { id: true, set: true, title: true, sort_order: true, seconds: true, enabled: true }
    });
    if (!existing) {
      return res.status(404).json({ error: 'SLIDE_NOT_FOUND' });
    }

    const { set, title, sort_order, seconds, enabled } = req.body || {};
    const dataToUpdate = {};

    if (set !== undefined) {
      const s = String(set).trim();
      if (!VALID_SETS.has(s)) {
        return res.status(422).json({ error: 'SLIDE_INVALID_SET', message: 'set 必須為 self 或 general' });
      }
      dataToUpdate.set = s;
    }
    if (title !== undefined) {
      const t = String(title ?? '').trim().slice(0, 64);
      if (!t) return res.status(422).json({ error: '標題不可為空' });
      dataToUpdate.title = t;
    }
    if (seconds !== undefined) {
      const sec = Number(seconds);
      if (!Number.isInteger(sec) || sec < 4 || sec > 60) {
        return res.status(422).json({ error: 'SLIDE_INVALID_SECONDS', message: '每張停留秒數必須為 4 到 60 秒' });
      }
      dataToUpdate.seconds = sec;
    }
    if (sort_order !== undefined) {
      const so = Number(sort_order);
      if (!Number.isInteger(so) || so < 0) {
        return res.status(422).json({ error: '排序必須為非負整數' });
      }
      dataToUpdate.sort_order = so;
    }
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') {
        return res.status(422).json({ error: 'enabled 必須為布林值' });
      }
      dataToUpdate.enabled = enabled;
    }

    const updated = await prisma.displaySlide.update({
      where: { id },
      data: dataToUpdate,
      select: {
        id: true,
        set: true,
        title: true,
        sort_order: true,
        seconds: true,
        enabled: true,
        mime: true,
        sha256: true,
        created_at: true,
        updated_at: true
      }
    });

    displayBus.settingsChanged();

    return res.json({ ok: true, slide: formatSlide(updated) });
  } catch (err) {
    console.error('[displaySlide] updateDisplaySlideHandler error:', err.message);
    return res.status(500).json({ error: '更新顯示屏輪播圖失敗' });
  }
}

export async function reorderDisplaySlidesHandler(req, res) {
  try {
    const { orders } = req.body || {};
    if (!Array.isArray(orders)) {
      return res.status(422).json({ error: 'INVALID_ORDERS_ARRAY' });
    }

    await prisma.$transaction(
      orders.map((item) =>
        prisma.displaySlide.update({
          where: { id: parseInt(item.id, 10) },
          data: { sort_order: parseInt(item.sort_order, 10) || 0 }
        })
      )
    );

    displayBus.settingsChanged();
    return res.json({ ok: true });
  } catch (err) {
    console.error('[displaySlide] reorderDisplaySlidesHandler error:', err.message);
    return res.status(500).json({ error: '重新排序輪播圖失敗' });
  }
}

export async function deleteDisplaySlideHandler(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '無效的輪播圖編號' });
  }

  try {
    const existing = await prisma.displaySlide.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      return res.status(404).json({ error: 'SLIDE_NOT_FOUND' });
    }

    await prisma.displaySlide.delete({ where: { id } });
    displayBus.settingsChanged();
    return res.json({ ok: true });
  } catch (err) {
    console.error('[displaySlide] deleteDisplaySlideHandler error:', err.message);
    return res.status(500).json({ error: '刪除顯示屏輪播圖失敗' });
  }
}

export async function downloadDisplaySlideHandler(req, res) {
  const id = parseInt(req.params.id, 10);
  const sha = String(req.params.sha256 || '').trim();
  if (!Number.isInteger(id) || id <= 0 || !sha) {
    return res.status(404).json({ error: 'SLIDE_NOT_FOUND' });
  }

  try {
    const slide = await prisma.displaySlide.findUnique({ where: { id } });
    if (!slide || slide.sha256 !== sha) {
      return res.status(404).json({ error: 'SLIDE_NOT_FOUND' });
    }

    res.setHeader('Content-Type', slide.mime);
    res.setHeader('Content-Length', slide.bytes.length);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', `"${slide.sha256}"`);
    return res.end(slide.bytes);
  } catch (err) {
    console.error('[displaySlide] downloadDisplaySlideHandler error:', err.message);
    return res.status(500).json({ error: '下載顯示屏輪播圖失敗' });
  }
}
