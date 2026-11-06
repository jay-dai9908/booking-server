// backend/src/controllers/seatLayoutController.js
import prisma from '../prismaClient.js';
import { getActiveLayoutForDate, getLegacyFallbackLayout, loadAllocatorContext } from '../services/seating/layoutService.js';
import { resolveLayoutGeometry } from '../../../shared/allocator/geometry.js';
import { allocate } from '../../../shared/allocator/score.js';
import { toTaipeiDateString } from '../../../shared/time.js';
import { allocateWithLayout } from '../services/seating/allocator.js';

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
        const key = z.key || z.id;
        zoneKeyMap.set(key, created.id);
      }

      // 4. Insert tables
      const tableKeyMap = new Map();
      for (const t of tables) {
        const zoneId = zoneKeyMap.get(t.zone_key || t.zone_id) || Array.from(zoneKeyMap.values())[0];
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
        const key = t.key || t.id;
        tableKeyMap.set(key, created.id);
      }

      // 5. Insert seats
      for (const s of seats) {
        let tableId = null;
        let zoneId = null;

        if (s.table_key || s.table_id) {
          tableId = tableKeyMap.get(s.table_key || s.table_id) || null;
        }

        if (tableId) {
          // Table seat zone must match table's zone
          const tObj = tables.find(t => (t.key || t.id) === (s.table_key || s.table_id));
          if (tObj) {
            zoneId = zoneKeyMap.get(tObj.zone_key || tObj.zone_id);
          }
        }
        if (!zoneId) {
          zoneId = zoneKeyMap.get(s.zone_key || s.zone_id) || Array.from(zoneKeyMap.values())[0];
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

    return res.json({
      server_now: new Date().toISOString(),
      message: '草稿儲存成功'
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
    const effDate = effective_from ? new Date(effective_from) : new Date();

    const draft = await prisma.seatLayout.findUnique({
      where: { id },
      include: { seats: true }
    });
    if (!draft) {
      return res.status(404).json({ error: '找不到該版面', code: 'LAYOUT_NOT_FOUND' });
    }

    const currentLayout = await getActiveLayoutForDate(prisma, effDate);
    const futureSessions = await prisma.session.findMany({
      where: { session_date: { gte: effDate } },
      select: { max_capacity: true }
    });
    const capacityBefore = futureSessions.length > 0
      ? Math.max(...futureSessions.map(s => s.max_capacity))
      : (currentLayout?.capacity || 20);
    const capacityAfter = draft.seats.filter(s => s.is_active && s.priority !== 'manual_only').length;

    // Check sessions over capacity on or after effective_from
    const sessions = await prisma.session.findMany({
      where: {
        session_date: { gte: effDate }
      },
      include: {
        reservations: {
          where: { status: 'confirmed' },
          select: { pax: true, booking_ref: true, attendance: true, assigned_seats: true }
        }
      }
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

    // Check affected bookings on deleted or disabled seats
    const newSeatCodes = new Set(draft.seats.filter(s => s.is_active).map(s => s.code));
    const affectedBookings = [];

    for (const sess of sessions) {
      for (const r of sess.reservations) {
        const missingSeats = (r.assigned_seats || []).filter(code => !newSeatCodes.has(code));
        if (missingSeats.length > 0) {
          affectedBookings.push({
            booking_ref: r.booking_ref,
            session_date: sess.session_date,
            time: `${sess.start_time}-${sess.end_time}`,
            missing_seats: missingSeats,
            pinned: r.attendance === 'checked_in'
          });
        }
      }
    }

    return res.json({
      server_now: new Date().toISOString(),
      capacity_before: capacityBefore,
      capacity_after: capacityAfter,
      sessions_over_capacity: sessionsOverCapacity,
      affected_bookings: affectedBookings
    });
  } catch (err) {
    console.error('previewPublish error:', err);
    return res.status(500).json({ error: '發布預覽評估失敗', code: 'PREVIEW_PUBLISH_FAILED' });
  }
}

export async function publishLayout(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const { effective_from, confirm } = req.body;
    if (!confirm) {
      return res.status(400).json({ error: '請確認發布', code: 'CONFIRM_REQUIRED' });
    }

    const effDate = effective_from ? new Date(effective_from) : new Date();
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

    const publishResult = await prisma.$transaction(async (tx) => {
      const currentLayout = await getActiveLayoutForDate(tx, effDate);
      const futureSessions = await tx.session.findMany({
        where: { session_date: { gte: effDate } },
        select: { max_capacity: true }
      });
      const capacityBefore = futureSessions.length > 0
        ? Math.max(...futureSessions.map(s => s.max_capacity))
        : (currentLayout?.capacity || 20);

      // 1. If effective today, check if any deleted/disabled seats are currently occupied right now
      if (effStr === todayStr) {
        const activeSeatsInDraft = new Set(draft.seats.filter(s => s.is_active).map(s => s.code));
        const todaySessions = await tx.session.findMany({
          where: { session_date: effDate },
          include: { reservations: { where: { status: 'confirmed', attendance: 'checked_in' } } }
        });

        const occupiedDeleted = new Set();
        for (const sess of todaySessions) {
          for (const r of sess.reservations) {
            for (const s of (r.assigned_seats || [])) {
              if (!activeSeatsInDraft.has(s)) {
                occupiedDeleted.add(s);
              }
            }
          }
        }

        if (occupiedDeleted.size > 0) {
          const listStr = Array.from(occupiedDeleted).join('、');
          throw new Error(`SEATS_OCCUPIED_TODAY:${listStr}`);
        }
      }

      // 2. Mark this layout as published and archive old layouts
      await tx.seatLayout.updateMany({
        where: {
          status: 'published',
          effective_from: effDate,
          id: { not: id }
        },
        data: { status: 'archived' }
      });

      const capacity = draft.seats.filter(s => s.is_active && s.priority !== 'manual_only').length;

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

      // 3. Update session max_capacity on/after effective_from
      await tx.session.updateMany({
        where: { session_date: { gte: effDate } },
        data: { max_capacity: capacity }
      });

      // 4. Enable seat_layout_enabled in GlobalSetting
      await tx.globalSetting.updateMany({
        data: { seat_layout_enabled: true }
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

      // 6. Reallocate reservations on deleted or disabled seats
      const activeNewSeats = new Set(draft.seats.filter(s => s.is_active).map(s => s.code));
      
      const futureResvs = await tx.reservation.findMany({
        where: {
          session: { session_date: { gte: effDate } },
          status: 'confirmed'
        },
        include: { session: true, user: true }
      });

      const bookingsMap = new Map();
      for (const r of futureResvs) {
        if (!bookingsMap.has(r.booking_ref)) {
          bookingsMap.set(r.booking_ref, []);
        }
        bookingsMap.get(r.booking_ref).push(r);
      }

      const reallocated = [];
      const needsManual = [];

      const ctx = await loadAllocatorContext(tx, effDate);

      for (const [bRef, bResvs] of bookingsMap.entries()) {
        const firstRes = bResvs[0];
        const assignedSeats = firstRes.assigned_seats || [];
        const missingSeats = assignedSeats.filter(code => !activeNewSeats.has(code));
        
        if (missingSeats.length === 0) {
          continue;
        }

        const isPinned = firstRes.attendance === 'checked_in' ||
                         Boolean(firstRes.is_seat_locked) ||
                         firstRes.seat_source === 'staff';

        const sessionDateStr = toTaipeiDateString(firstRes.session.session_date);
        const timeStr = `${bResvs[0].session.start_time}-${bResvs[bResvs.length - 1].session.end_time}`;

        if (isPinned) {
          needsManual.push({
            booking_ref: bRef,
            name: firstRes.user?.name || '客人',
            date: sessionDateStr,
            time: timeStr,
            missing_seats: missingSeats,
            pinned: true
          });
          continue;
        }

        // Try to reallocate movable reservation
        const bSessionIds = bResvs.map(r => r.session_id);
        const bPax = firstRes.pax;
        const bForceSplit = Boolean(firstRes.is_force_split);

        const sessionResvs = await tx.reservation.findMany({
          where: { session_id: { in: bSessionIds }, status: { not: 'cancelled' } }
        });
        const otherResvs = sessionResvs.filter(r => r.booking_ref !== bRef);

        const newReservationBlock = {
          booking_ref: bRef,
          pax: bPax,
          session_ids: bSessionIds,
          original_sessions: bResvs
        };

        const allocResult = allocateWithLayout(otherResvs, newReservationBlock, bForceSplit, ctx);

        if (allocResult.success) {
          const myUpdate = allocResult.updates?.find(u => u.booking_ref === bRef);
          const newSeats = myUpdate?.assigned_seats;
          if (newSeats && newSeats.length && !newSeats.some(s => s.startsWith('WAIT-'))) {
            await tx.reservation.updateMany({
              where: { booking_ref: bRef },
              data: { assigned_seats: newSeats }
            });

            // Sync booking person seats
            const bPersons = await tx.bookingPerson.findMany({
              where: { booking_ref: bRef },
              orderBy: { person_no: 'asc' }
            });
            for (let i = 0; i < bPersons.length; i++) {
              await tx.bookingPerson.update({
                where: { id: bPersons[i].id },
                data: { seat_code: newSeats[i] || null }
              });
            }

            reallocated.push({
              booking_ref: bRef,
              name: firstRes.user?.name || '客人',
              from: assignedSeats,
              to: newSeats
            });
            continue;
          }
        }

        needsManual.push({
          booking_ref: bRef,
          name: firstRes.user?.name || '客人',
          date: sessionDateStr,
          time: timeStr,
          missing_seats: missingSeats,
          pinned: false
        });
      }

      return {
        capacity_before: capacityBefore,
        capacity_after: capacity,
        capacity,
        renamed: renamedBookings,
        reallocated,
        needs_manual: needsManual
      };
    });

    return res.json({
      server_now: new Date().toISOString(),
      message: '版面發布成功',
      ...publishResult
    });
  } catch (err) {
    if (err.message?.startsWith('SEATS_OCCUPIED_TODAY:')) {
      const seatsStr = err.message.replace('SEATS_OCCUPIED_TODAY:', '');
      return res.status(409).json({
        error: `這些座位現在有人坐，不能今天刪除：${seatsStr}`,
        code: 'SEATS_OCCUPIED_TODAY'
      });
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
