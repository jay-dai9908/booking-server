import prisma from '../../prismaClient.js';
import { getLiveFloorData } from '../floor/liveService.js';
import { getDayType } from './dayType.js';
import { decide, DEFAULT_DISPLAY_SCHEDULE } from '../../../../shared/displaySchedule.js';
import { buildFloorMap } from '../../../../shared/floorMap.js';
import { toTaipeiDateString, dateOnly } from '../../../../shared/time.js';
import {
  ensureDisplaySetting,
  resolveSharedLineInfo
} from '../../controllers/displaySettingController.js';
import { getEnabledPaymentMethods, resolveTwqrConfig } from './displayConfigHelper.js';
import displayBus from './displayBus.js';

function getTaipeiHour(date) {
  const str = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    hour12: false
  }).format(date);
  return parseInt(str, 10) || 0;
}

async function resolveDateContext(dateStr, schedule, specialDates, serverNow) {
  const [dayType, sessions] = await Promise.all([
    getDayType(dateStr, prisma),
    prisma.session.findMany({
      where: { session_date: dateOnly(dateStr) },
      orderBy: { start_time: 'asc' },
      select: { start_time: true, end_time: true }
    })
  ]);

  const openTime = sessions.length > 0 ? sessions[0].start_time : null;
  const closeTime = sessions.length > 0 ? sessions[sessions.length - 1].end_time : null;
  const decision = decide({
    dayType,
    schedule,
    specialDates,
    date: dateStr,
    now: serverNow,
    openTime,
    closeTime
  });

  return { dateStr, dayType, openTime, closeTime, decision };
}

function enrichFloorMapWithHereElement(floorMap, rawLayout, mapRotation, hereElement) {
  floorMap.rotation = [0, 90, 180, 270].includes(Number(mapRotation))
    ? Number(mapRotation)
    : 90;

  let elements = [];
  if (rawLayout) {
    if (Array.isArray(rawLayout.elements_json)) {
      elements = rawLayout.elements_json;
    } else if (typeof rawLayout.elements_json === 'string') {
      try {
        elements = JSON.parse(rawLayout.elements_json);
      } catch {
        elements = [];
      }
    }
  }

  const shapeSourceElems = elements.filter((el) => {
    const t = el?.type || el?.kind;
    return t === 'wall' || t === 'window' || t === 'pillar' || t === 'door' || t === 'counter' || t === 'fixture';
  });

  let hereIndex = -1;
  const targetHere = hereElement ? String(hereElement).trim() : '';

  if (Array.isArray(floorMap.shapes)) {
    floorMap.shapes.forEach((shape, idx) => {
      const src = shapeSourceElems[idx];
      const srcId = src?.id !== undefined && src?.id !== null && String(src.id).trim() !== ''
        ? String(src.id).trim()
        : null;
      const label = String(shape.label || src?.label || '').trim();
      const key = srcId || (label ? `${shape.kind}:${label}` : null);
      shape.id = srcId;
      shape.key = key;

      if (targetHere && hereIndex === -1 && shape.kind === 'fixture') {
        if (
          (srcId && srcId === targetHere) ||
          (key && key === targetHere) ||
          (label && `${shape.kind}:${label}` === targetHere) ||
          (src?.type && label && `${src.type}:${label}` === targetHere) ||
          (label && label === targetHere)
        ) {
          hereIndex = idx;
        }
      }
    });
  }

  floorMap.here_index = hereIndex;
  return floorMap;
}

export async function buildDisplayState(serverNow = new Date()) {
  const nowDate = serverNow instanceof Date ? serverNow : new Date(serverNow);
  const serverNowMs = nowDate.getTime();
  const displaySetting = await ensureDisplaySetting(prisma);

  const schedule = displaySetting.schedule && typeof displaySetting.schedule === 'object'
    ? displaySetting.schedule
    : DEFAULT_DISPLAY_SCHEDULE;
  const specialDates = Array.isArray(displaySetting.special_dates)
    ? displaySetting.special_dates
    : [];

  const todayStr = toTaipeiDateString(nowDate);
  let ctx = await resolveDateContext(todayStr, schedule, specialDates, nowDate);

  // If currently after midnight (00:00..04:59) and today's schedule isn't on,
  // check if yesterday's schedule crossed midnight and is still active.
  if (!ctx.decision.on && getTaipeiHour(nowDate) < 5) {
    const yesterdayStr = toTaipeiDateString(new Date(serverNowMs - 12 * 3600 * 1000));
    if (yesterdayStr && yesterdayStr !== todayStr) {
      const yCtx = await resolveDateContext(yesterdayStr, schedule, specialDates, nowDate);
      if (yCtx.decision.on) {
        ctx = yCtx;
      }
    }
  }

  const businessDateStr = ctx.dateStr;
  const businessDate = dateOnly(businessDateStr);

  const [liveData, resMetaRows, equipmentConfigs, globalSetting, lineInfo, enabledPaymentMethods] = await Promise.all([
    getLiveFloorData(businessDateStr, nowDate),
    prisma.reservation.findMany({
      where: {
        session: { session_date: businessDate },
        status: { not: 'cancelled' }
      },
      select: {
        booking_ref: true,
        is_unlimited: true,
        checkout_details: true
      }
    }),
    prisma.equipmentConfig.findMany({
      where: {
        visibility_status: { not: 'HIDDEN' },
        id: { not: 'bring_own' }
      },
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        hourly_rate: true,
        self_hourly_rate: true
      }
    }),
    prisma.globalSetting.findUnique({
      where: { id: 1 },
      select: {
        equipment_discount_enabled: true,
        equipment_discount_buy_hours: true,
        equipment_discount_free_hours: true
      }
    }),
    resolveSharedLineInfo(prisma),
    getEnabledPaymentMethods(prisma)
  ]);

  let slidesPayload = { self: [], general: [] };
  if (prisma.displaySlide) {
    const slideRows = await prisma.displaySlide.findMany({
      where: { enabled: true },
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        set: true,
        title: true,
        sort_order: true,
        seconds: true,
        sha256: true
      }
    });
    for (const s of slideRows) {
      const item = {
        id: s.id,
        set: s.set,
        title: s.title,
        sort_order: s.sort_order,
        seconds: s.seconds,
        sha256: s.sha256,
        url: `/api/display/files/slides/${s.id}/${s.sha256}`
      };
      if (s.set === 'self') slidesPayload.self.push(item);
      else if (s.set === 'general') slidesPayload.general.push(item);
    }
  }

  const resMetaMap = new Map();
  for (const r of resMetaRows) {
    if (!resMetaMap.has(r.booking_ref)) {
      resMetaMap.set(r.booking_ref, {
        is_unlimited: Boolean(r.is_unlimited),
        checkout_details: r.checkout_details || null
      });
    }
  }

  const floorMap = enrichFloorMapWithHereElement(
    buildFloorMap(liveData.layout || {}),
    liveData.layout,
    displaySetting.map_rotation,
    displaySetting.here_element
  );

  // Build sanitized seats from liveData.bookings (exact parity with liveService timers; zero PII)
  const seatEntries = new Map();
  const seatEndMsMap = new Map(); // internal only for next_available
  const expiringBoards = [];

  for (const b of liveData.bookings || []) {
    if (b.attendance === 'completed') continue;

    const resMeta = resMetaMap.get(b.booking_ref) || { is_unlimited: false, checkout_details: null };
    const startMs = b.start_at ? new Date(b.start_at).getTime() : serverNowMs;
    const endMs = b.end_at ? new Date(b.end_at).getTime() : startMs;
    const bookedHours = Math.max(0, Math.round(((endMs - startMs) / 3600000) * 100) / 100);

    if (b.attendance === 'checked_in') {
      const persons = Array.isArray(b.persons) ? b.persons : [];
      const boards = Array.isArray(b.boards) ? b.boards : [];

      if (persons.length > 0) {
        for (const p of persons) {
          if (p.status !== 'active' || !p.seat_code) continue;
          if (p.timer?.timer_ended_at) continue;

          const pDraft = Array.isArray(resMeta.checkout_details?.persons)
            ? resMeta.checkout_details.persons.find((dp) => dp.person_no === p.person_no)
            : null;
          const mode = pDraft?.mode === 'unlimited'
            ? 'unlimited'
            : (pDraft?.mode === 'hourly' ? 'hourly' : (resMeta.is_unlimited ? 'unlimited' : 'hourly'));
          const hours = pDraft?.hours_override != null && Number.isFinite(Number(pDraft.hours_override))
            ? Number(pDraft.hours_override)
            : bookedHours;

          let pausedSeconds = Number(p.timer?.paused_seconds || 0);
          if (p.timer?.paused_at && !p.timer?.timer_ended_at) {
            pausedSeconds += Math.max(0, Math.floor((serverNowMs - new Date(p.timer.paused_at).getTime()) / 1000));
          }

          const originAt = p.timer?.billing_start_at || p.timer?.timer_started_at || b.start_at;
          const state = mode === 'unlimited'
            ? 'unlimited'
            : ((p.timer?.paused_at || pausedSeconds > 0) ? 'paused' : 'running');

          const hasBoard = boards.some((bd) => {
            const matchesPerson = bd.person_no != null ? bd.person_no === p.person_no : p.person_no === 1;
            if (!matchesPerson) return false;
            return (bd.segments || []).some((seg) => !seg.end_at && !seg.ended_reason);
          });

          seatEntries.set(p.seat_code, {
            code: p.seat_code,
            state,
            origin_at: originAt,
            mode,
            hours,
            paused_seconds: pausedSeconds,
            has_board: hasBoard
          });

          if (mode === 'hourly' && hours > 0 && originAt) {
            const estEnd = new Date(originAt).getTime() + hours * 3600000 + pausedSeconds * 1000;
            seatEndMsMap.set(p.seat_code, estEnd);
          }
        }
      } else {
        // Checked-in booking without BookingPerson rows yet (needs_seating)
        const assigned = (b.assigned_seats || []).filter((c) => c && !String(c).startsWith('WAIT-'));
        const mode = resMeta.is_unlimited ? 'unlimited' : 'hourly';
        const state = mode === 'unlimited' ? 'unlimited' : 'running';
        const originAt = b.checked_in_at || b.start_at;
        const anyActiveBoard = boards.some((bd) => (bd.segments || []).some((seg) => !seg.end_at && !seg.ended_reason));

        assigned.forEach((code, idx) => {
          seatEntries.set(code, {
            code,
            state,
            origin_at: originAt,
            mode,
            hours: bookedHours,
            paused_seconds: 0,
            has_board: idx === 0 && anyActiveBoard
          });
          if (mode === 'hourly' && bookedHours > 0 && originAt) {
            seatEndMsMap.set(code, new Date(originAt).getTime() + bookedHours * 3600000);
          }
        });
      }

      // Expiring boards within 30 minutes (or already overtime)
      for (const bd of boards) {
        const activeSeg = (bd.segments || []).find((seg) => !seg.end_at && !seg.ended_reason);
        if (!activeSeg) continue;
        const baseEndIso = activeSeg.planned_end_at || b.end_at;
        if (!baseEndIso) continue;
        let boardPauseMs = 0;
        for (const bp of (bd.pauses || [])) {
          const ps = bp.started_at ? new Date(bp.started_at).getTime() : 0;
          const pe = bp.ended_at ? new Date(bp.ended_at).getTime() : serverNowMs;
          if (ps > 0 && pe > ps) boardPauseMs += (pe - ps);
        }
        const endsAtMs = new Date(baseEndIso).getTime() + boardPauseMs;
        if (endsAtMs - serverNowMs <= 30 * 60000) {
          expiringBoards.push({
            name: activeSeg.name || '智能板',
            ends_at: new Date(endsAtMs).toISOString()
          });
        }
      }
    } else {
      // Booked (not yet checked in): only show if reservation window hasn't ended yet
      if (endMs > serverNowMs) {
        const assigned = (b.assigned_seats || []).filter((c) => c && !String(c).startsWith('WAIT-'));
        const mode = resMeta.is_unlimited ? 'unlimited' : 'hourly';
        for (const code of assigned) {
          const existing = seatEntries.get(code);
          if (existing && existing.state !== 'booked') continue; // active checked-in guest has priority
          if (existing && existing.state === 'booked' && new Date(existing.origin_at).getTime() <= startMs) continue;
          seatEntries.set(code, {
            code,
            state: 'booked',
            origin_at: b.start_at,
            mode,
            hours: bookedHours,
            paused_seconds: 0,
            has_board: false
          });
        }
      }
    }
  }

  const seats = Array.from(seatEntries.values()).sort((a, b) => a.code.localeCompare(b.code));

  // Cards summary
  const activeLayoutSeats = (liveData.layout?.seats || []).filter((s) => s.is_active !== false);
  const totalSeatCodes = activeLayoutSeats.length > 0
    ? activeLayoutSeats.map((s) => s.code)
    : (floorMap.seats || []).map((s) => s.code);

  const seatedCodeSet = new Set(seats.filter((s) => s.state !== 'booked').map((s) => s.code));
  const freeSeats = totalSeatCodes.filter((code) => !seatedCodeSet.has(code)).length;

  const futureEnds = Array.from(seatEndMsMap.values())
    .filter((t) => t > serverNowMs)
    .sort((a, b) => a - b);
  const earliestEnd = futureEnds.length > 0 ? futureEnds[0] : null;
  const nextAvailable = earliestEnd
    ? {
        at: new Date(earliestEnd).toISOString(),
        count: futureEnds.filter((t) => t - earliestEnd < 15 * 60000).length
      }
    : null;

  const bookedWithinHour = seats.filter((s) => {
    if (s.state !== 'booked' || seatedCodeSet.has(s.code)) return false;
    const origMs = new Date(s.origin_at).getTime();
    return origMs - serverNowMs <= 3600000;
  }).length;

  expiringBoards.sort((a, b) => new Date(a.ends_at).getTime() - new Date(b.ends_at).getTime());

  const price = {
    hourly: liveData.pricing?.hourly ?? 100,
    unlimited: liveData.pricing?.unlimited ?? 550,
    allow_unlimited: liveData.pricing?.allow_unlimited ?? true,
    boards: equipmentConfigs.map((c) => ({
      id: c.id,
      name: c.name,
      hourly_rate: ctx.dayType === 'self' && c.self_hourly_rate != null ? c.self_hourly_rate : c.hourly_rate
    })),
    board_discount: globalSetting
      ? {
          enabled: Boolean(globalSetting.equipment_discount_enabled),
          buy_hours: globalSetting.equipment_discount_buy_hours ?? 3,
          free_hours: globalSetting.equipment_discount_free_hours ?? 1
        }
      : { enabled: true, buy_hours: 3, free_hours: 1 }
  };

  const twqrMeta = resolveTwqrConfig(displaySetting);

  return {
    server_now: nowDate.toISOString(),
    date: businessDateStr,
    day_type: ctx.dayType,
    decision: ctx.decision,
    open: ctx.openTime,
    close: ctx.closeTime,
    floor_map: floorMap,
    seats,
    cards: {
      free_seats: freeSeats,
      next_available: nextAvailable,
      booked_within_hour: bookedWithinHour,
      expiring_boards: expiringBoards
    },
    price,
    announcements: Array.isArray(displaySetting.announcements) ? displaySetting.announcements : [],
    line: {
      url: lineInfo.line_url,
      id: lineInfo.line_id,
      title: displaySetting.line_title || '有問題請加 LINE'
    },
    notices: Array.isArray(displaySetting.notices) ? displaySetting.notices : [],
    slides: slidesPayload,
    payment_methods: enabledPaymentMethods,
    twqr: {
      has_twqr: twqrMeta.has_twqr,
      use_raw_image: twqrMeta.has_raw_image,
      raw_image_url: twqrMeta.raw_image_url,
      logo_enabled: twqrMeta.logo_enabled,
      logo_url: twqrMeta.logo_url
    },
    checkout: displayBus.getActiveCheckout(),
    message: displayBus.getActiveMessage(),
    settings: {
      map_rotation: displaySetting.map_rotation,
      here_element: displaySetting.here_element,
      time_mode: displaySetting.time_mode,
      soon_minutes: displaySetting.soon_minutes,
      fallback_to_slides: displaySetting.fallback_to_slides,
      cards: displaySetting.cards,
      card_seconds: displaySetting.card_seconds,
      announcement_seconds: displaySetting.announcement_seconds,
      show_line_mini: displaySetting.show_line_mini,
      closing_warn: displaySetting.closing_warn,
      closing_minutes: displaySetting.closing_minutes,
      shift_minutes: displaySetting.shift_minutes,
      slide_seconds: displaySetting.slide_seconds,
      checkout_sync: displaySetting.checkout_sync ?? true,
      checkout_wake: displaySetting.checkout_wake ?? true,
      checkout_per_person: displaySetting.checkout_per_person ?? true,
      thanks_seconds: displaySetting.thanks_seconds ?? 8,
      idle_minutes: displaySetting.idle_minutes ?? 5,
      message_minutes: displaySetting.message_minutes ?? 3
    }
  };
}
