// backend/src/controllers/seatLayoutController.js
import prisma from '../prismaClient.js';
import { getActiveLayoutForDate, getLegacyFallbackLayout, loadAllocatorContext } from '../services/seating/layoutService.js';
import { resolveLayoutGeometry } from '../../../shared/allocator/geometry.js';
import { allocate } from '../../../shared/allocator/score.js';
import { toTaipeiDateString, dateOnly } from '../../../shared/time.js';
import { allocateWithLayout, reseatBookings, assertNoSeatCollisions } from '../services/seating/allocator.js';
import { isBookingCompleted } from '../../../shared/floorSelectors.js';
import { log as auditLog } from '../services/audit/auditService.js';

export async function getActiveLayout(req, res) {
  try {
    const { date } = req.query;
    const layout = await getActiveLayoutForDate(prisma, date);
    return res.json({
      server_now: new Date().toISOString(),
      ...layout
    });
  } catch (err) {
    console.error('getActiveLayout error:', err);
    return res.status(500).json({ error: '載入生效版面失敗', code: 'LOAD_ACTIVE_LAYOUT_FAILED' });
  }
}

export async function listLayouts(req, res) {
  try {
    const layouts = await prisma.seatLayout.findMany({
      orderBy: [{ id: 'desc' }],
      select: {
        id: true,
        name: true,
        status: true,
        effective_from: true,
        capacity: true,
        created_by_name: true,
        published_by_name: true,
        published_at: true,
        updated_at: true
      }
    });
    return res.json({
      server_now: new Date().toISOString(),
      layouts
    });
  } catch (err) {
    console.error('listLayouts error:', err);
    return res.status(500).json({ error: '載入版面清單失敗', code: 'LIST_LAYOUTS_FAILED' });
  }
}

export async function getLayoutById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const layout = await prisma.seatLayout.findUnique({
      where: { id },
      include: {
        zones: { orderBy: { sort_order: 'asc' } },
        tables: { orderBy: { sort_order: 'asc' } },
        seats: { orderBy: { sort_order: 'asc' } }
      }
    });

    if (!layout) {
      return res.status(404).json({ error: '找不到該版面', code: 'LAYOUT_NOT_FOUND' });
    }

    const resolved = resolveLayoutGeometry(layout);
    return res.json({
      server_now: new Date().toISOString(),
      layout: resolved
    });
  } catch (err) {
    console.error('getLayoutById error:', err);
    return res.status(500).json({ error: '載入版面失敗', code: 'GET_LAYOUT_FAILED' });
  }
}

export async function createLayoutDraft(req, res) {
  try {
    const { from_id } = req.body;
    let baseLayout = null;

    if (from_id) {
      baseLayout = await prisma.seatLayout.findUnique({
        where: { id: parseInt(from_id, 10) },
        include: { zones: true, tables: true, seats: true }
      });
    }

    if (!baseLayout) {
      baseLayout = await prisma.seatLayout.findFirst({
        where: { status: 'published' },
        orderBy: [{ effective_from: 'desc' }, { id: 'desc' }],
        include: { zones: true, tables: true, seats: true }
      });
    }

    if (!baseLayout) {
      baseLayout = getLegacyFallbackLayout();
    }

    const staffName = req.user?.name || '管理員';

    const draft = await prisma.$transaction(async (tx) => {
      const newLayout = await tx.seatLayout.create({
        data: {
          name: `${baseLayout.name} (草稿)`,
          status: 'draft',
          canvas_w: baseLayout.canvas_w || 1000,
          canvas_h: baseLayout.canvas_h || 625,
          seat_tile_w: baseLayout.seat_tile_w || 60,
          seat_tile_h: baseLayout.seat_tile_h || 46,
          grid_size: baseLayout.grid_size || 10,
          background_image: baseLayout.background_image || null,
          background_opacity: baseLayout.background_opacity ?? 0.35,
          background_rect: baseLayout.background_rect || null,
          elements_json: baseLayout.elements_json || [],
          rules_json: baseLayout.rules_json || {},
          capacity: baseLayout.capacity || 16,
          created_by_name: staffName
        }
      });

      // Map old zone ids to new zone ids
      const zoneIdMap = new Map();
      for (const z of (baseLayout.zones || [])) {
        const createdZone = await tx.seatZone.create({
          data: {
            layout_id: newLayout.id,
            name: z.name,
            note: z.note,
            sort_order: z.sort_order,
            polygon: z.polygon
          }
        });
        zoneIdMap.set(z.id, createdZone.id);
      }

      // Map old table ids to new table ids
      const tableIdMap = new Map();
      for (const t of (baseLayout.tables || [])) {
        const newZoneId = zoneIdMap.get(t.zone_id) || Array.from(zoneIdMap.values())[0];
        const createdTable = await tx.seatTable.create({
          data: {
            layout_id: newLayout.id,
            zone_id: newZoneId,
            label: t.label,
            shape: t.shape,
            arrangement: t.arrangement,
            cx: t.cx,
            cy: t.cy,
            w: t.w,
            h: t.h,
            rotation: t.rotation,
            sort_order: t.sort_order
          }
        });
        tableIdMap.set(t.id, createdTable.id);
      }

      // Seats
      for (const s of (baseLayout.seats || [])) {
        const newZoneId = zoneIdMap.get(s.zone_id) || Array.from(zoneIdMap.values())[0];
        const newTableId = s.table_id ? tableIdMap.get(s.table_id) || null : null;
        await tx.seat.create({
          data: {
            layout_id: newLayout.id,
            table_id: newTableId,
            zone_id: newZoneId,
            code: s.code,
            lx: s.lx,
            ly: s.ly,
            side_mode: s.side_mode || 'auto',
            side: s.side || null,
            tags: s.tags || [],
            priority: s.priority || 'normal',
            is_active: s.is_active !== false,
            adjacent_codes: s.adjacent_codes || [],
            opposite_codes: s.opposite_codes || [],
            sort_order: s.sort_order || 0,
            origin_code: s.code
          }
        });
      }

      return newLayout;
    });

    return res.status(201).json({
      server_now: new Date().toISOString(),
      layout_id: draft.id
    });
  } catch (err) {
    console.error('createLayoutDraft error:', err);
    return res.status(500).json({ error: '建立版面草稿失敗', code: 'CREATE_DRAFT_FAILED' });
  }
}

export async function updateLayoutDraft(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.seatLayout.findUnique({
      where: { id }
    });

    if (!existing) {
      return res.status(404).json({ error: '找不到該版面', code: 'LAYOUT_NOT_FOUND' });
    }
    if (existing.status !== 'draft') {
      return res.status(409).json({ error: '已發布的版面不能直接改，請先建立草稿', code: 'CANNOT_MODIFY_PUBLISHED' });
    }

    const {
      name,
      canvas_w,
      canvas_h,
      seat_tile_w,
      seat_tile_h,
      grid_size,
      background_image,
      background_opacity,
      background_rect,
      elements_json,
      rules_json,
      zones = [],
      tables = [],
      seats = []
    } = req.body;

    // Validation (Section 5.1)
    if (!zones || zones.length === 0) {
      return res.status(422).json({ error: '至少要有一個區域', code: 'ZONE_REQUIRED' });
    }

    const codeRegex = /^[A-Za-z0-9-]{1,8}$/;
    const seenCodes = new Set();
    for (const s of seats) {
      if (!s.code || !codeRegex.test(s.code)) {
        return res.status(422).json({ error: `座位代號格式不符 (1-8 字元英文數字)：${s.code}`, code: 'INVALID_SEAT_CODE' });
      }
      if (seenCodes.has(s.code)) {
        return res.status(422).json({ error: `座位代號重複：${s.code}`, code: 'DUPLICATE_SEAT_CODE' });
      }
      seenCodes.add(s.code);
    }

    // Ensure bidirectional link for adjacent_codes and opposite_codes (Item 7.2)
    const seatMap = new Map(seats.map(s => [s.code, s]));
    for (const s of seats) {
      for (const adjCode of (s.adjacent_codes || [])) {
        const neighbor = seatMap.get(adjCode);
        if (neighbor) {
          if (!Array.isArray(neighbor.adjacent_codes)) neighbor.adjacent_codes = [];
          if (!neighbor.adjacent_codes.includes(s.code)) {
            neighbor.adjacent_codes.push(s.code);
          }
        }
      }
      for (const oppCode of (s.opposite_codes || [])) {
        const neighbor = seatMap.get(oppCode);
        if (neighbor) {
          if (!Array.isArray(neighbor.opposite_codes)) neighbor.opposite_codes = [];
          if (!neighbor.opposite_codes.includes(s.code)) {
            neighbor.opposite_codes.push(s.code);
          }
        }
      }
    }

    // Save in transaction: replace zones, tables, seats
    await prisma.$transaction(async (tx) => {
      // 1. Update Layout details
      // Calculate capacity: is_active = true and priority !== 'manual_only'
      const capacity = seats.filter(s => s.is_active !== false && s.priority !== 'manual_only').length;

      await tx.seatLayout.update({
        where: { id },
        data: {
          name: name || existing.name,
          canvas_w: canvas_w || existing.canvas_w,
          canvas_h: canvas_h || existing.canvas_h,
          seat_tile_w: seat_tile_w || existing.seat_tile_w,
          seat_tile_h: seat_tile_h || existing.seat_tile_h,
          grid_size: grid_size || existing.grid_size,
          background_image: background_image !== undefined ? background_image : existing.background_image,
          background_opacity: background_opacity !== undefined ? Number(background_opacity) : existing.background_opacity,
          background_rect: background_rect !== undefined ? background_rect : existing.background_rect,
          elements_json: elements_json || existing.elements_json,
          rules_json: rules_json || existing.rules_json,
          capacity
        }
      });

      // 2. Delete existing seats, tables, zones
      await tx.seat.deleteMany({ where: { layout_id: id } });
      await tx.seatTable.deleteMany({ where: { layout_id: id } });
      await tx.seatZone.deleteMany({ where: { layout_id: id } });

      // 3. Insert zones
      const zoneKeyMap = new Map();
      for (const z of zones) {
        const created = await tx.seatZone.create({
          data: {
            layout_id: id,
            name: z.name,
            note: z.note || null,
            sort_order: Number(z.sort_order) || 0,
            polygon: z.polygon || null
          }
        });
        if (z.id != null) {
          zoneKeyMap.set(z.id, created.id);
          zoneKeyMap.set(String(z.id), created.id);
        }
        if (z.key) {
          zoneKeyMap.set(z.key, created.id);
          zoneKeyMap.set(String(z.key), created.id);
        }
      }

      // 4. Insert tables
      const tableKeyMap = new Map();
      for (const t of tables) {
        const zoneId = (t.zone_key ? zoneKeyMap.get(t.zone_key) : null) ||
                       (t.zone_id != null ? (zoneKeyMap.get(t.zone_id) || zoneKeyMap.get(String(t.zone_id))) : null) ||
                       Array.from(zoneKeyMap.values())[0];
        // Normalize rotation to -180 ~ 180
        let rot = (Number(t.rotation) || 0) % 360;
        if (rot > 180) rot -= 360;
        if (rot < -180) rot += 360;

        const created = await tx.seatTable.create({
          data: {
            layout_id: id,
            zone_id: zoneId,
            label: t.label || '桌子',
            shape: t.shape || 'rect',
            arrangement: t.arrangement || 'two_sides',
            cx: Number(t.cx) || 0,
            cy: Number(t.cy) || 0,
            w: Number(t.w) || 60,
            h: Number(t.h) || 150,
            rotation: rot,
            sort_order: Number(t.sort_order) || 0
          }
        });
        if (t.id != null) {
          tableKeyMap.set(t.id, created.id);
          tableKeyMap.set(String(t.id), created.id);
        }
        if (t.key) {
          tableKeyMap.set(t.key, created.id);
          tableKeyMap.set(String(t.key), created.id);
        }
      }

      // 5. Insert seats
      for (const s of seats) {
        let tableId = null;
        let zoneId = null;

        if (s.table_key != null && tableKeyMap.has(s.table_key)) {
          tableId = tableKeyMap.get(s.table_key);
        } else if (s.table_id != null && tableKeyMap.has(s.table_id)) {
          tableId = tableKeyMap.get(s.table_id);
        } else if (s.table_id != null && tableKeyMap.has(String(s.table_id))) {
          tableId = tableKeyMap.get(String(s.table_id));
        }

        if (tableId) {
          // Table seat zone must match table's zone
          const tObj = tables.find(t =>
            (t.key && (t.key === s.table_key || t.key === s.table_id)) ||
            (t.id != null && (t.id === s.table_id || String(t.id) === String(s.table_id)))
          );
          if (tObj) {
            zoneId = (tObj.zone_key ? zoneKeyMap.get(tObj.zone_key) : null) ||
                     (tObj.zone_id != null ? (zoneKeyMap.get(tObj.zone_id) || zoneKeyMap.get(String(tObj.zone_id))) : null);
          }
        }
        if (!zoneId) {
          zoneId = (s.zone_key ? zoneKeyMap.get(s.zone_key) : null) ||
                   (s.zone_id != null ? (zoneKeyMap.get(s.zone_id) || zoneKeyMap.get(String(s.zone_id))) : null) ||
                   Array.from(zoneKeyMap.values())[0];
        }

        await tx.seat.create({
          data: {
            layout_id: id,
            table_id: tableId,
            zone_id: zoneId,
            code: s.code,
            lx: Number(s.lx) || 0,
            ly: Number(s.ly) || 0,
            side_mode: s.side_mode || 'auto',
            side: s.side || null,
            tags: s.tags || [],
            priority: s.priority || 'normal',
            is_active: s.is_active !== false,
            adjacent_codes: s.adjacent_codes || [],
            opposite_codes: s.opposite_codes || [],
            sort_order: Number(s.sort_order) || 0,
            origin_code: s.origin_code || s.code
          }
        });
      }
    });

    const updated = await prisma.seatLayout.findUnique({
      where: { id },
      include: {
        zones: { orderBy: { sort_order: 'asc' } },
        tables: { orderBy: { sort_order: 'asc' } },
        seats: { orderBy: { sort_order: 'asc' } }
      }
    });
    const resolved = resolveLayoutGeometry(updated);

    return res.json({
      server_now: new Date().toISOString(),
      message: '草稿儲存成功',
      layout: resolved
    });
  } catch (err) {
    console.error('updateLayoutDraft error:', err);
    return res.status(500).json({ error: '儲存版面失敗', code: 'UPDATE_DRAFT_FAILED' });
  }
}

export async function previewPublish(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const { effective_from } = req.body;
    const effDate = dateOnly(effective_from || toTaipeiDateString(new Date()));

    const draft = await prisma.seatLayout.findUnique({
      where: { id },
      include: { zones: true, tables: true, seats: true }
    });
    if (!draft) {
      return res.status(404).json({ error: '找不到該版面', code: 'LAYOUT_NOT_FOUND' });
    }

    const evaluation = await evaluateLayoutImpact(prisma, draft, effDate);

    return res.json({
      server_now: new Date().toISOString(),
      capacity_before: evaluation.capacityBefore,
      capacity_after: evaluation.capacityAfter,
      capacity: evaluation.capacityAfter,
      sessions_over_capacity: evaluation.sessionsOverCapacity,
      sessions_capacity_exceeding_seats_count: evaluation.sessionsCapacityExceedingSeatsCount,
      affected_bookings: evaluation.affectedBookings,
      category_c: evaluation.category_c,
      category_b: evaluation.category_b,
      in_store_reseat: evaluation.in_store_reseat,
      auto_reseat: evaluation.auto_reseat,
      needs_manual: evaluation.needs_manual
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error('previewPublish error:', err);
    return res.status(500).json({ error: '發布預覽評估失敗', code: 'PREVIEW_PUBLISH_FAILED' });
  }
}

/**
 * Evaluates the impact of publishing a layout draft on or after effDate.
 * Categorizes affected bookings into:
 *   Category A (已結束): completed / departed / past / cancelled (completely ignored)
 *   Category B (還沒到): unseated bookings to be reseated
 *   Category C (正在座位上): in-store seated guests with running/paused timers to be reseated
 * Computes suggested seats or falls back to WAIT-n.
 * Throws 409 if total seated pax > active bookable seats + waiting capacity.
 */
async function evaluateLayoutImpact(client, draft, effDate) {
  const currentLayout = await getActiveLayoutForDate(client, effDate);
  const futureSessions = await client.session.findMany({
    where: { session_date: { gte: effDate } },
    select: { max_capacity: true }
  });
  const capacityBefore = futureSessions.length > 0
    ? Math.max(...futureSessions.map(s => s.max_capacity))
    : (currentLayout?.capacity || 20);
  const capacityAfter = draft.seats.filter(s => s.is_active && s.priority !== 'manual_only').length;

  const sessions = await client.session.findMany({
    where: { session_date: { gte: effDate } },
    include: {
      reservations: {
        where: { status: { not: 'cancelled' } },
        include: { session: true, user: true }
      }
    },
    orderBy: [
      { session_date: 'asc' },
      { start_time: 'asc' }
    ]
  });

  const sessionsOverCapacity = [];
  for (const sess of sessions) {
    const bookedPax = sess.reservations.reduce((s, r) => s + r.pax, 0);
    if (bookedPax > capacityAfter) {
      sessionsOverCapacity.push({
        session_id: sess.id,
        session_date: sess.session_date,
        start_time: sess.start_time,
        end_time: sess.end_time,
        booked_pax: bookedPax,
        capacity_after: capacityAfter
      });
    }
  }

  const allBookingRefs = [...new Set(sessions.flatMap(s => s.reservations.map(r => r.booking_ref)))];
  const allPersons = allBookingRefs.length > 0 ? await client.bookingPerson.findMany({
    where: { booking_ref: { in: allBookingRefs }, status: 'active' },
    include: { pauses: true },
    orderBy: { person_no: 'asc' }
  }) : [];
  const allPayments = allBookingRefs.length > 0 ? await client.payment.findMany({
    where: { booking_ref: { in: allBookingRefs }, status: 'valid' }
  }) : [];

  const personsMap = new Map();
  for (const p of allPersons) {
    if (!personsMap.has(p.booking_ref)) personsMap.set(p.booking_ref, []);
    personsMap.get(p.booking_ref).push(p);
  }

  const paymentsMap = new Map();
  for (const pay of allPayments) {
    if (!paymentsMap.has(pay.booking_ref)) paymentsMap.set(pay.booking_ref, []);
    paymentsMap.get(pay.booking_ref).push(pay);
  }

  const bookingsMap = new Map();
  for (const sess of sessions) {
    for (const r of sess.reservations) {
      if (!bookingsMap.has(r.booking_ref)) bookingsMap.set(r.booking_ref, []);
      bookingsMap.get(r.booking_ref).push(r);
    }
  }

  const activeNewSeats = new Set(draft.seats.filter(s => s.is_active).map(s => s.code));
  const maxWaitCapacity = draft.rules_json?.max_wait_capacity ?? 8;
  const serverNow = new Date();

  const categoryA = [];
  const categoryB = [];
  const categoryC = [];

  for (const [bRef, bResvs] of bookingsMap.entries()) {
    const firstRes = bResvs[0];
    const lastRes = bResvs[bResvs.length - 1];
    const bPersons = personsMap.get(bRef) || [];
    const bPayments = paymentsMap.get(bRef) || [];

    const assignedSeats = firstRes.assigned_seats || [];
    const missingSeats = assignedSeats.filter(code => !code.startsWith('WAIT-') && !activeNewSeats.has(code));

    const sessionDateStr = toTaipeiDateString(lastRes.session.session_date);
    const endDt = new Date(`${sessionDateStr}T${lastRes.session.end_time}:00+08:00`);
    const isPastOrEnded = endDt.getTime() <= serverNow.getTime();

    const bookingObj = {
      booking_ref: bRef,
      attendance: firstRes.attendance,
      status: firstRes.status,
      is_paid: Boolean(firstRes.is_paid),
      billing_status: firstRes.billing_status,
      billing: { status: firstRes.billing_status },
      end_at: endDt.toISOString(),
      persons: bPersons.map(p => ({
        person_no: p.person_no,
        paid: bPayments.some(pay => pay.person_nos?.includes(p.person_no) || !pay.person_nos || pay.person_nos.length === 0),
        timer: {
          timer_started_at: p.timer_started_at,
          billing_start_at: p.billing_start_at,
          timer_ended_at: p.timer_ended_at,
          paused_at: p.paused_at
        }
      }))
    };

    const isCompleted = firstRes.status === 'cancelled' ||
      firstRes.attendance === 'completed' ||
      isBookingCompleted(bookingObj, serverNow);

    const isSeatedWithRunningTimer =
      (firstRes.attendance === 'checked_in' || firstRes.checked_in_at != null) &&
      bPersons.length > 0 &&
      bPersons.some(p => (p.timer_started_at || p.billing_start_at) && !p.timer_ended_at);

    if (isCompleted) {
      // Category A: 已結束
      categoryA.push({ booking_ref: bRef, bResvs, firstRes, missingSeats });
    } else if (isSeatedWithRunningTimer) {
      // Category C: 正在座位上 (even if scheduled session has passed, they are still on seats!)
      categoryC.push({ booking_ref: bRef, bResvs, firstRes, lastRes, bPersons, missingSeats });
    } else if (isPastOrEnded) {
      // Category A: Past slot that ended without active in-store presence
      categoryA.push({ booking_ref: bRef, bResvs, firstRes, missingSeats });
    } else {
      // Category B: 還沒到
      const isPinned = Boolean(firstRes.is_seat_locked) || firstRes.seat_source === 'staff';
      if (isPinned && missingSeats.length === 0) {
        // 座位沒有被刪或停用的鎖定訂單，完全不列出、不處理。
        continue;
      }
      categoryB.push({ booking_ref: bRef, bResvs, firstRes, lastRes, bPersons, missingSeats, isPinned });
    }
  }

  // 1.2 Check blocking condition:
  // 新版面的座位數少於「現在正在座位上的人數」，而且等待區也放不下。這時回 409
  const totalSeatedPax = categoryC.reduce((sum, c) => sum + c.firstRes.pax, 0);
  if (totalSeatedPax > capacityAfter + maxWaitCapacity) {
    const err = new Error(`新版面的座位不夠目前在場的 ${totalSeatedPax} 位客人，請先調整版面或等客人離場`);
    err.status = 409;
    err.code = 'INSUFFICIENT_SEATS_FOR_SEATED';
    throw err;
  }

  // Reseat affected bookings in Category C and Category B
  const reseatC = categoryC.filter(c => c.missingSeats.length > 0);
  const reseatB = categoryB.filter(b => b.missingSeats.length > 0);

  // Initialize occupancy map per session with non-moving, uncompleted bookings
  const movingRefs = new Set([...reseatC.map(c => c.booking_ref), ...reseatB.map(b => b.booking_ref)]);
  const completedRefs = new Set(categoryA.map(a => a.booking_ref));

  const occMap = new Map();
  for (const sess of sessions) {
    if (!occMap.has(sess.id)) occMap.set(sess.id, new Set());
    for (const r of sess.reservations) {
      if (movingRefs.has(r.booking_ref) || completedRefs.has(r.booking_ref)) {
        continue;
      }
      for (const sc of (r.assigned_seats || [])) {
        if (!sc.startsWith('WAIT-') && activeNewSeats.has(sc)) {
          occMap.get(sess.id).add(sc);
        }
      }
    }
  }

  let waitCounter = 1;
  const processedCategoryC = [];
  const processedCategoryB = [];
  const needsManual = [];

  const tryReseatBooking = (b) => {
    const bSessionIds = b.bResvs.map(r => r.session_id);
    const unionOccupied = new Set();
    for (const sid of bSessionIds) {
      for (const sc of (occMap.get(sid) || [])) {
        unionOccupied.add(sc);
      }
    }

    const dummyResvs = [];
    for (const sid of bSessionIds) {
      for (const seatCode of unionOccupied) {
        dummyResvs.push({
          booking_ref: `__OCC_${sid}_${seatCode}__`,
          session_id: sid,
          pax: 1,
          assigned_seats: [seatCode],
          is_pinned: true,
          attendance: 'checked_in'
        });
      }
    }

    const block = {
      booking_ref: b.booking_ref,
      pax: b.firstRes.pax,
      session_ids: bSessionIds,
      original_sessions: b.bResvs,
      original_seats: b.firstRes.assigned_seats || []
    };

    let alloc = allocateWithLayout(dummyResvs, block, false, { layout: draft, rules: draft.rules_json });
    if (!alloc.success || !alloc.updates?.[0]?.assigned_seats?.length || alloc.updates[0].assigned_seats.some(s => s.startsWith('WAIT-'))) {
      alloc = allocateWithLayout(dummyResvs, block, true, { layout: draft, rules: draft.rules_json });
    }

    if (alloc.success && alloc.updates?.[0]?.assigned_seats?.length && !alloc.updates[0].assigned_seats.some(s => s.startsWith('WAIT-'))) {
      const newSeats = alloc.updates[0].assigned_seats;
      for (const sid of bSessionIds) {
        for (const sc of newSeats) {
          occMap.get(sid)?.add(sc);
        }
      }
      return { success: true, to: newSeats, is_wait: false };
    }

    // Fallback to waiting area
    const waitSeats = Array.from({ length: b.firstRes.pax }, () => `WAIT-${waitCounter++}`);
    return { success: false, to: waitSeats, is_wait: true };
  };

  // 1. Reseat Category C (In-store guests)
  for (const c of reseatC) {
    const res = tryReseatBooking(c);
    const sessionDateStr = toTaipeiDateString(c.firstRes.session.session_date);
    const timeStr = `${c.bResvs[0].session.start_time}-${c.bResvs[c.bResvs.length - 1].session.end_time}`;
    const item = {
      booking_ref: c.booking_ref,
      name: c.firstRes.user?.name || '客人',
      pax: c.firstRes.pax,
      time: timeStr,
      date: sessionDateStr,
      from: c.firstRes.assigned_seats || [],
      to: res.to,
      is_wait: res.is_wait,
      persons: c.bPersons
    };

    if (res.is_wait) {
      needsManual.push({ ...item, reason: '座位不足，放進等待區' });
    } else {
      processedCategoryC.push(item);
    }
  }

  // 2. Reseat Category B (Upcoming bookings)
  for (const b of reseatB) {
    const res = tryReseatBooking(b);
    const sessionDateStr = toTaipeiDateString(b.firstRes.session.session_date);
    const timeStr = `${b.bResvs[0].session.start_time}-${b.bResvs[b.bResvs.length - 1].session.end_time}`;
    const item = {
      booking_ref: b.booking_ref,
      name: b.firstRes.user?.name || '客人',
      pax: b.firstRes.pax,
      time: timeStr,
      date: sessionDateStr,
      from: b.firstRes.assigned_seats || [],
      to: res.to,
      is_wait: res.is_wait,
      bPersons: b.bPersons,
      persons: b.bPersons,
      ...(b.isPinned ? { pinned: true, note: '原本是店員指定的座位' } : {})
    };

    if (res.is_wait) {
      needsManual.push({
        ...item,
        reason: b.isPinned ? '座位不足，放進等待區（原本是店員指定的座位）' : '座位不足，放進等待區'
      });
    } else {
      processedCategoryB.push(item);
    }
  }

  // Construct affected_bookings for legacy/backward compatibility
  const affectedBookings = [
    ...processedCategoryC.map(c => ({
      booking_ref: c.booking_ref,
      name: c.name,
      time: c.time,
      missing_seats: c.from.filter(sc => !activeNewSeats.has(sc)),
      pinned: true,
      category: 'C'
    })),
    ...processedCategoryB.map(b => ({
      booking_ref: b.booking_ref,
      name: b.name,
      time: b.time,
      missing_seats: b.from.filter(sc => !activeNewSeats.has(sc)),
      pinned: false,
      category: 'B'
    })),
    ...needsManual.map(m => ({
      booking_ref: m.booking_ref,
      name: m.name,
      time: m.time,
      missing_seats: m.from.filter(sc => !activeNewSeats.has(sc)),
      pinned: false,
      category: 'wait'
    }))
  ];

  const sessionsCapacityExceedingSeats = sessions.filter(s => s.max_capacity > capacityAfter);

  return {
    capacityBefore,
    capacityAfter,
    sessionsOverCapacity,
    sessionsCapacityExceedingSeatsCount: sessionsCapacityExceedingSeats.length,
    affectedBookings,
    category_c: processedCategoryC,
    category_b: processedCategoryB,
    in_store_reseat: processedCategoryC,
    auto_reseat: processedCategoryB,
    needs_manual: needsManual,
    sessions,
    totalSeatedPax
  };
}

export async function publishLayout(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const { effective_from, confirm, manual_overrides = {} } = req.body;
    if (!confirm) {
      return res.status(400).json({ error: '請確認發布', code: 'CONFIRM_REQUIRED' });
    }

    const effDate = dateOnly(effective_from || toTaipeiDateString(new Date()));
    const todayStr = toTaipeiDateString(new Date());
    const effStr = toTaipeiDateString(effDate);

    if (effStr < todayStr) {
      return res.status(422).json({ error: '生效日期必須大於或等於今天', code: 'EFFECTIVE_DATE_PAST' });
    }

    const draft = await prisma.seatLayout.findUnique({
      where: { id },
      include: { zones: true, tables: true, seats: true }
    });
    if (!draft) {
      return res.status(404).json({ error: '找不到該版面', code: 'LAYOUT_NOT_FOUND' });
    }

    const staffName = req.user?.name || '店長';

    // 1. Evaluate impact (throws 409 if seats + waiting cannot fit in-store seated guests)
    const evaluation = await evaluateLayoutImpact(prisma, draft, effDate);

    const publishResult = await prisma.$transaction(async (tx) => {
      // 2. Mark this layout as published and archive old layouts
      await tx.seatLayout.updateMany({
        where: {
          status: 'published',
          effective_from: effDate,
          id: { not: id }
        },
        data: { status: 'archived' }
      });

      const capacity = evaluation.capacityAfter;

      await tx.seatLayout.update({
        where: { id },
        data: {
          status: 'published',
          effective_from: effDate,
          published_by_name: staffName,
          published_at: new Date(),
          capacity
        }
      });

      // 3. Do NOT modify session max_capacity (capacity is decoupled from online max_capacity)

      // 4. Enable seat_layout_enabled in GlobalSetting
      await tx.globalSetting.upsert({
        where: { id: 1 },
        update: { seat_layout_enabled: true },
        create: { id: 1, seat_layout_enabled: true }
      });

      // 5. Renamed seats update in future reservations
      const renamedSeats = draft.seats.filter(s => s.origin_code && s.origin_code !== s.code);
      const renamedMap = new Map(renamedSeats.map(s => [s.origin_code, s.code]));

      const futureReservations = await tx.reservation.findMany({
        where: {
          session: { session_date: { gte: effDate } },
          status: 'confirmed'
        }
      });

      const renamedBookings = [];
      for (const r of futureReservations) {
        let changed = false;
        const newSeats = (r.assigned_seats || []).map(code => {
          if (renamedMap.has(code)) {
            changed = true;
            return renamedMap.get(code);
          }
          return code;
        });

        if (changed) {
          await tx.reservation.update({
            where: { id: r.id },
            data: { assigned_seats: newSeats }
          });
          renamedBookings.push({ booking_ref: r.booking_ref, from: r.assigned_seats, to: newSeats });
        }
      }

      // 6. Apply reseat for Category C (in-store guests)
      for (const c of evaluation.category_c) {
        const targetSeats = manual_overrides[c.booking_ref] || c.to;
        await tx.reservation.updateMany({
          where: { booking_ref: c.booking_ref, status: { not: 'cancelled' } },
          data: { assigned_seats: targetSeats }
        });

        for (let i = 0; i < c.persons.length; i++) {
          await tx.bookingPerson.update({
            where: { id: c.persons[i].id },
            data: { seat_code: targetSeats[i] || null }
          });
        }
      }

      // 7. Apply reseat for Category B (upcoming bookings)
      for (const b of evaluation.category_b) {
        const targetSeats = manual_overrides[b.booking_ref] || b.to;
        await tx.reservation.updateMany({
          where: { booking_ref: b.booking_ref, status: { not: 'cancelled' } },
          data: { assigned_seats: targetSeats }
        });
        const bPersons = (b.bPersons && b.bPersons.length > 0)
          ? b.bPersons
          : ((b.persons && b.persons.length > 0)
            ? b.persons
            : await tx.bookingPerson.findMany({ where: { booking_ref: b.booking_ref } }));
        if (bPersons && bPersons.length > 0) {
          for (let i = 0; i < bPersons.length; i++) {
            await tx.bookingPerson.update({
              where: { id: bPersons[i].id },
              data: { seat_code: targetSeats[i] || null }
            });
          }
        }
      }

      // 8. Apply reseat for needs_manual (wait area or staff overrides)
      for (const m of evaluation.needs_manual) {
        const targetSeats = manual_overrides[m.booking_ref] || m.to;
        if (targetSeats && targetSeats.length > 0) {
          await tx.reservation.updateMany({
            where: { booking_ref: m.booking_ref, status: { not: 'cancelled' } },
            data: { assigned_seats: targetSeats }
          });

          const mPersons = await tx.bookingPerson.findMany({ where: { booking_ref: m.booking_ref } });
          for (let i = 0; i < mPersons.length; i++) {
            await tx.bookingPerson.update({
              where: { id: mPersons[i].id },
              data: { seat_code: targetSeats[i] || null }
            });
          }
        }
      }

      // 9. Write audit log
      const countB = evaluation.category_b.length;
      const countC = evaluation.category_c.length;
      const countWait = evaluation.needs_manual.filter(m => {
        const targetSeats = manual_overrides[m.booking_ref] || m.to;
        return Array.isArray(targetSeats) && targetSeats.some(sc => sc.startsWith('WAIT-'));
      }).length;
      await auditLog(tx, {
        event_type: 'layout_published',
        category: 'status',
        summary: `發布座位版面：改排 ${countB} 筆、在場換座 ${countC} 筆、等待區 ${countWait} 筆`,
        staff_name: staffName,
        device_label: '管理後台'
      });

      // 10. Assert no collisions in all touched sessions
      const allTouchedSessionIds = [...new Set(evaluation.sessions.map(s => s.id))];
      await assertNoSeatCollisions(tx, allTouchedSessionIds);

      return {
        capacity_before: evaluation.capacityBefore,
        capacity_after: capacity,
        capacity,
        renamed: renamedBookings,
        category_c: evaluation.category_c,
        category_b: evaluation.category_b,
        in_store_reseat: evaluation.category_c,
        auto_reseat: evaluation.category_b,
        reallocated: [...evaluation.category_c, ...evaluation.category_b],
        needs_manual: evaluation.needs_manual
      };
    });

    return res.json({
      server_now: new Date().toISOString(),
      message: '版面發布成功',
      ...publishResult
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error('publishLayout error:', err);
    return res.status(500).json({ error: '發布版面失敗', code: 'PUBLISH_LAYOUT_FAILED' });
  }
}

export async function updateLayoutRules(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const { rules_json } = req.body;
    if (!rules_json) {
      return res.status(400).json({ error: '缺少規則設定', code: 'MISSING_RULES' });
    }

    const layout = await prisma.seatLayout.findUnique({
      where: { id }
    });
    if (!layout) {
      return res.status(404).json({ error: '找不到該版面', code: 'LAYOUT_NOT_FOUND' });
    }

    await prisma.seatLayout.update({
      where: { id },
      data: { rules_json }
    });

    return res.json({
      server_now: new Date().toISOString(),
      message: '排位規則更新成功'
    });
  } catch (err) {
    console.error('updateLayoutRules error:', err);
    return res.status(500).json({ error: '更新排位規則失敗', code: 'UPDATE_RULES_FAILED' });
  }
}

export async function deleteLayout(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const layout = await prisma.seatLayout.findUnique({ where: { id } });
    if (!layout) {
      return res.status(404).json({ error: '找不到該版面', code: 'LAYOUT_NOT_FOUND' });
    }
    if (layout.status !== 'draft') {
      return res.status(409).json({ error: '只能刪除草稿版面', code: 'ONLY_DRAFT_CAN_BE_DELETED' });
    }

    await prisma.seatLayout.delete({ where: { id } });
    return res.json({ server_now: new Date().toISOString(), message: '草稿已刪除' });
  } catch (err) {
    console.error('deleteLayout error:', err);
    return res.status(500).json({ error: '刪除草稿失敗', code: 'DELETE_DRAFT_FAILED' });
  }
}

export async function allocatePreview(req, res) {
  try {
    const { layout_id, draft, date, session_id, pax } = req.body;
    let layoutObj = draft;

    if (!layoutObj && layout_id) {
      const dbLayout = await prisma.seatLayout.findUnique({
        where: { id: parseInt(layout_id, 10) },
        include: { zones: true, tables: true, seats: true }
      });
      if (dbLayout) layoutObj = dbLayout;
    }

    if (!layoutObj) {
      layoutObj = await getActiveLayoutForDate(prisma, date);
    }

    const resolved = resolveLayoutGeometry(layoutObj);

    // Fetch existing reservations for session_id to populate occupancy
    const occupancy = {};
    if (session_id) {
      occupancy[session_id] = {};
      const reservations = await prisma.reservation.findMany({
        where: { session_id: parseInt(session_id, 10), status: 'confirmed' }
      });
      for (const r of reservations) {
        for (const s of (r.assigned_seats || [])) {
          occupancy[session_id][s] = r.booking_ref;
        }
      }
    }

    const sessionIds = session_id ? [session_id] : [1];
    const allocResult = allocate({
      layout: resolved,
      rules: layoutObj.rules_json || {},
      pax: parseInt(pax, 10) || 1,
      sessionIds,
      occupancy: Object.keys(occupancy).length > 0 ? occupancy : { [sessionIds[0]]: {} },
      allowSplit: false
    });

    return res.json({
      server_now: new Date().toISOString(),
      ...allocResult
    });
  } catch (err) {
    console.error('allocatePreview error:', err);
    return res.status(500).json({ error: '排位試算失敗', code: 'ALLOCATE_PREVIEW_FAILED' });
  }
}
