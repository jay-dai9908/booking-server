import prisma from '../prismaClient.js';
import { dateOnly } from '../../../shared/time.js';
import {
  DEFAULT_DISPLAY_SCHEDULE,
  VALID_DAY_TYPES,
  VALID_DISPLAY_MODES,
  VALID_DISPLAY_CONTENTS
} from '../../../shared/displaySchedule.js';
import { getActiveLayoutForDate } from '../services/seating/layoutService.js';
import { ensureKioskSetting } from './dailySettingController.js';
import displayBus from '../services/display/displayBus.js';

const VALID_ROTATIONS = new Set([0, 90, 180, 270]);
const VALID_TIME_MODES = new Set(['remain', 'used']);
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function getDefaultDisplaySettingData() {
  return {
    id: 1,
    schedule: structuredClone(DEFAULT_DISPLAY_SCHEDULE),
    special_dates: [],
    map_rotation: 90,
    here_element: null,
    time_mode: 'remain',
    soon_minutes: 10,
    fallback_to_slides: true,
    cards: { seats: true, soon: true, price: true },
    card_seconds: 12,
    announcements: [],
    announcement_seconds: 10,
    show_line_mini: true,
    line_title: '有問題請加 LINE',
    notices: [],
    closing_warn: true,
    closing_minutes: 30,
    shift_minutes: 3,
    slide_seconds: 8
  };
}

export async function ensureDisplaySetting(txOrPrisma = prisma) {
  let ds = await txOrPrisma.displaySetting.findUnique({ where: { id: 1 } });
  if (!ds) {
    ds = await txOrPrisma.displaySetting.create({
      data: getDefaultDisplaySettingData()
    });
  }
  return ds;
}

export async function resolveSharedLineInfo(txOrPrisma = prisma) {
  const [ks, gs] = await Promise.all([
    ensureKioskSetting(txOrPrisma),
    txOrPrisma.globalSetting.findUnique({
      where: { id: 1 },
      select: { official_line_url: true, line_button_url: true }
    })
  ]);

  const line_url =
    (ks?.line_url && ks.line_url.trim()) ||
    gs?.official_line_url ||
    gs?.line_button_url ||
    '';
  const line_id = (ks?.line_id || '').trim();
  return { line_url, line_id };
}

export function extractFloorElements(layout) {
  if (!layout) return [];
  let elements = [];
  if (Array.isArray(layout.elements_json)) {
    elements = layout.elements_json;
  } else if (typeof layout.elements_json === 'string') {
    try {
      elements = JSON.parse(layout.elements_json);
    } catch {
      elements = [];
    }
  }

  const out = [];
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const rawType = el.type || el.kind;
    if (rawType !== 'counter' && rawType !== 'fixture') continue;
    const label = String(el.label || '').trim();
    const idVal = el.id !== undefined && el.id !== null && String(el.id).trim() !== ''
      ? String(el.id).trim()
      : null;
    if (!idVal && !label) continue;
    const value = idVal || `fixture:${label}`;
    out.push({
      value,
      id: idVal,
      kind: 'fixture',
      type: rawType,
      label: label || '設施'
    });
  }
  return out;
}

function parseIntStrict(val, min, max, label) {
  if (val === null || val === undefined || val === '' || typeof val === 'boolean') {
    return { error: `${label}必須為 ${min} 到 ${max} 的整數` };
  }
  const num = Number(val);
  if (!Number.isInteger(num) || num < min || num > max) {
    return { error: `${label}必須為 ${min} 到 ${max} 的整數` };
  }
  return { value: num };
}

function isValidCalendarDate(ymd) {
  if (!YMD_RE.test(ymd)) return false;
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export async function getDisplaySettings(req, res) {
  try {
    const [setting, lineInfo, layout] = await Promise.all([
      ensureDisplaySetting(prisma),
      resolveSharedLineInfo(prisma),
      getActiveLayoutForDate(prisma, dateOnly(new Date()))
    ]);

    return res.json({
      ...setting,
      line_url: lineInfo.line_url,
      line_id: lineInfo.line_id,
      floor_elements: extractFloorElements(layout)
    });
  } catch (err) {
    console.error('[displaySetting] getDisplaySettings error:', err.message);
    return res.status(500).json({ error: '無法讀取顯示屏設定' });
  }
}

export async function updateDisplaySettings(req, res) {
  const body = req.body || {};

  try {
    const existing = await ensureDisplaySetting(prisma);
    const dataToUpdate = {};

    // 1. schedule
    if (body.schedule !== undefined) {
      if (!body.schedule || typeof body.schedule !== 'object' || Array.isArray(body.schedule)) {
        return res.status(422).json({ error: '排程格式無效' });
      }
      const nextSchedule = {
        ...DEFAULT_DISPLAY_SCHEDULE,
        ...(existing.schedule && typeof existing.schedule === 'object' ? existing.schedule : {})
      };
      for (const [dayKey, rule] of Object.entries(body.schedule)) {
        if (!VALID_DAY_TYPES.includes(dayKey)) {
          return res.status(422).json({ error: `不支援的日期類型：${dayKey}` });
        }
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
          return res.status(422).json({ error: `${dayKey} 排程規則格式無效` });
        }
        const prevRule = nextSchedule[dayKey] || DEFAULT_DISPLAY_SCHEDULE[dayKey];
        const mode = rule.mode !== undefined ? String(rule.mode) : prevRule.mode;
        if (!VALID_DISPLAY_MODES.includes(mode)) {
          return res.status(422).json({ error: `${dayKey} 開關模式無效` });
        }
        const content = rule.content !== undefined ? String(rule.content) : prevRule.content;
        if (!VALID_DISPLAY_CONTENTS.includes(content)) {
          return res.status(422).json({ error: `${dayKey} 顯示內容無效` });
        }
        const beforeCheck = rule.before !== undefined
          ? parseIntStrict(rule.before, 0, 180, `${dayKey} 提早開啟分鐘`)
          : { value: prevRule.before ?? 0 };
        if (beforeCheck.error) return res.status(422).json({ error: beforeCheck.error });

        const afterCheck = rule.after !== undefined
          ? parseIntStrict(rule.after, 0, 240, `${dayKey} 延後關閉分鐘`)
          : { value: prevRule.after ?? 0 };
        if (afterCheck.error) return res.status(422).json({ error: afterCheck.error });

        const onStr = rule.on !== undefined ? String(rule.on ?? '').trim() : (prevRule.on || '');
        const offStr = rule.off !== undefined ? String(rule.off ?? '').trim() : (prevRule.off || '');

        if (mode === 'fixed') {
          if (!HHMM_RE.test(onStr) || !HHMM_RE.test(offStr)) {
            return res.status(422).json({ error: `${dayKey} 固定時間格式必須為 HH:mm` });
          }
        } else {
          if (onStr && !HHMM_RE.test(onStr)) {
            return res.status(422).json({ error: `${dayKey} 開啟時間格式必須為 HH:mm` });
          }
          if (offStr && !HHMM_RE.test(offStr)) {
            return res.status(422).json({ error: `${dayKey} 關閉時間格式必須為 HH:mm` });
          }
        }

        nextSchedule[dayKey] = {
          mode,
          before: beforeCheck.value,
          after: afterCheck.value,
          on: onStr,
          off: offStr,
          content
        };
      }
      dataToUpdate.schedule = nextSchedule;
    }

    // 2. special_dates
    if (body.special_dates !== undefined) {
      if (!Array.isArray(body.special_dates)) {
        return res.status(422).json({ error: '特殊日期必須為陣列' });
      }
      if (body.special_dates.length > 100) {
        return res.status(422).json({ error: '特殊日期最多 100 筆' });
      }
      const cleanedSpecials = [];
      for (const item of body.special_dates) {
        if (!item || typeof item !== 'object') {
          return res.status(422).json({ error: '特殊日期項目格式無效' });
        }
        const dateStr = String(item.date || '').trim();
        const offStr = String(item.off || '').trim();
        const noteStr = String(item.note || '').trim().slice(0, 64);
        if (!isValidCalendarDate(dateStr)) {
          return res.status(422).json({ error: `特殊日期格式無效：${dateStr}` });
        }
        if (!HHMM_RE.test(offStr)) {
          return res.status(422).json({ error: `特殊日期關閉時間格式無效：${offStr}` });
        }
        cleanedSpecials.push({ date: dateStr, off: offStr, note: noteStr });
      }
      dataToUpdate.special_dates = cleanedSpecials;
    }

    // 3. map_rotation
    if (body.map_rotation !== undefined) {
      const rot = Number(body.map_rotation);
      if (!Number.isInteger(rot) || !VALID_ROTATIONS.has(rot)) {
        return res.status(422).json({ error: '平面圖旋轉角度必須為 0、90、180 或 270' });
      }
      dataToUpdate.map_rotation = rot;
    }

    // 4. here_element
    if (body.here_element !== undefined) {
      if (body.here_element === null || body.here_element === '') {
        dataToUpdate.here_element = null;
      } else {
        const clean = String(body.here_element).trim();
        if (clean.length > 128) {
          return res.status(422).json({ error: '「你在這裡」設施識別值過長' });
        }
        dataToUpdate.here_element = clean || null;
      }
    }

    // 5. time_mode
    if (body.time_mode !== undefined) {
      const tm = String(body.time_mode);
      if (!VALID_TIME_MODES.has(tm)) {
        return res.status(422).json({ error: '座位計時顯示模式必須為 remain 或 used' });
      }
      dataToUpdate.time_mode = tm;
    }

    // 6. soon_minutes (1..60)
    if (body.soon_minutes !== undefined) {
      const r = parseIntStrict(body.soon_minutes, 1, 60, '快到時間提醒分鐘');
      if (r.error) return res.status(422).json({ error: r.error });
      dataToUpdate.soon_minutes = r.value;
    }

    // 7. fallback_to_slides
    if (body.fallback_to_slides !== undefined) {
      if (typeof body.fallback_to_slides !== 'boolean') {
        return res.status(422).json({ error: 'fallback_to_slides 必須為布林值' });
      }
      dataToUpdate.fallback_to_slides = body.fallback_to_slides;
    }

    // 8. cards
    if (body.cards !== undefined) {
      if (!body.cards || typeof body.cards !== 'object' || Array.isArray(body.cards)) {
        return res.status(422).json({ error: '右側資訊卡設定格式無效' });
      }
      const prevCards = existing.cards && typeof existing.cards === 'object'
        ? existing.cards
        : { seats: true, soon: true, price: true };
      const nextCards = { ...prevCards };
      for (const k of ['seats', 'soon', 'price']) {
        if (body.cards[k] !== undefined) {
          if (typeof body.cards[k] !== 'boolean') {
            return res.status(422).json({ error: `cards.${k} 必須為布林值` });
          }
          nextCards[k] = body.cards[k];
        }
      }
      dataToUpdate.cards = nextCards;
    }

    // 9. card_seconds (5..60)
    if (body.card_seconds !== undefined) {
      const r = parseIntStrict(body.card_seconds, 5, 60, '資訊卡每張停留秒數');
      if (r.error) return res.status(422).json({ error: r.error });
      dataToUpdate.card_seconds = r.value;
    }

    // 10. announcements (max 10)
    if (body.announcements !== undefined) {
      if (!Array.isArray(body.announcements)) {
        return res.status(422).json({ error: '公告必須為陣列' });
      }
      const cleaned = body.announcements.map(s => String(s ?? '').trim()).filter(Boolean);
      if (cleaned.length > 10) {
        return res.status(422).json({ error: '公告最多只能設定 10 則' });
      }
      dataToUpdate.announcements = cleaned.map(s => s.slice(0, 200));
    }

    // 11. announcement_seconds (5..60)
    if (body.announcement_seconds !== undefined) {
      const r = parseIntStrict(body.announcement_seconds, 5, 60, '公告每則停留秒數');
      if (r.error) return res.status(422).json({ error: r.error });
      dataToUpdate.announcement_seconds = r.value;
    }

    // 12. show_line_mini
    if (body.show_line_mini !== undefined) {
      if (typeof body.show_line_mini !== 'boolean') {
        return res.status(422).json({ error: 'show_line_mini 必須為布林值' });
      }
      dataToUpdate.show_line_mini = body.show_line_mini;
    }

    // 13. line_title
    if (body.line_title !== undefined) {
      const cleanTitle = String(body.line_title ?? '').trim();
      if (cleanTitle.length > 64) {
        return res.status(422).json({ error: 'LINE 條碼標題最多 64 字' });
      }
      dataToUpdate.line_title = cleanTitle || '有問題請加 LINE';
    }

    // 14. notices (max 5)
    if (body.notices !== undefined) {
      if (!Array.isArray(body.notices)) {
        return res.status(422).json({ error: '注意事項必須為陣列' });
      }
      const cleaned = body.notices.map(s => String(s ?? '').trim()).filter(Boolean);
      if (cleaned.length > 5) {
        return res.status(422).json({ error: '注意事項最多只能設定 5 條' });
      }
      dataToUpdate.notices = cleaned.map(s => s.slice(0, 200));
    }

    // 15. closing_warn
    if (body.closing_warn !== undefined) {
      if (typeof body.closing_warn !== 'boolean') {
        return res.status(422).json({ error: 'closing_warn 必須為布林值' });
      }
      dataToUpdate.closing_warn = body.closing_warn;
    }

    // 16. closing_minutes (5..120)
    if (body.closing_minutes !== undefined) {
      const r = parseIntStrict(body.closing_minutes, 5, 120, '打烊提醒分鐘');
      if (r.error) return res.status(422).json({ error: r.error });
      dataToUpdate.closing_minutes = r.value;
    }

    // 17. shift_minutes (1..60)
    if (body.shift_minutes !== undefined) {
      const r = parseIntStrict(body.shift_minutes, 1, 60, '防烙印微移間隔分鐘');
      if (r.error) return res.status(422).json({ error: r.error });
      dataToUpdate.shift_minutes = r.value;
    }

    // 18. slide_seconds (4..60)
    if (body.slide_seconds !== undefined) {
      const r = parseIntStrict(body.slide_seconds, 4, 60, '輪播每張停留秒數');
      if (r.error) return res.status(422).json({ error: r.error });
      dataToUpdate.slide_seconds = r.value;
    }

    // Optional: sync shared KioskSetting.line_url / line_id without duplicating in DisplaySetting
    const kioskUpdate = {};
    if (body.line_url !== undefined) {
      const cleanUrl = String(body.line_url ?? '').trim();
      if (cleanUrl && !/^https?:\/\//i.test(cleanUrl)) {
        return res.status(422).json({ error: 'LINE 連結必須以 http:// 或 https:// 開頭' });
      }
      kioskUpdate.line_url = cleanUrl || null;
    }
    if (body.line_id !== undefined) {
      const cleanId = String(body.line_id ?? '').trim().slice(0, 64);
      kioskUpdate.line_id = cleanId || null;
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (Object.keys(kioskUpdate).length > 0) {
        await tx.kioskSetting.upsert({
          where: { id: 1 },
          update: {
            ...kioskUpdate,
            config_rev: { increment: 1 }
          },
          create: {
            id: 1,
            line_url: kioskUpdate.line_url ?? null,
            line_id: kioskUpdate.line_id ?? null,
            config_rev: 1
          }
        });
      }

      return tx.displaySetting.upsert({
        where: { id: 1 },
        update: dataToUpdate,
        create: {
          ...getDefaultDisplaySettingData(),
          ...dataToUpdate
        }
      });
    });

    const [lineInfo, layout] = await Promise.all([
      resolveSharedLineInfo(prisma),
      getActiveLayoutForDate(prisma, dateOnly(new Date()))
    ]);

    displayBus.settingsChanged();

    return res.json({
      message: '顯示設定已儲存',
      setting: {
        ...updated,
        line_url: lineInfo.line_url,
        line_id: lineInfo.line_id,
        floor_elements: extractFloorElements(layout)
      }
    });
  } catch (err) {
    console.error('[displaySetting] updateDisplaySettings error:', err.message);
    return res.status(500).json({ error: '儲存顯示設定失敗' });
  }
}
