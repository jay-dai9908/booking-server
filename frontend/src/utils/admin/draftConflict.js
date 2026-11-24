/**
 * 草稿衝突比對與 3-way 合併工具（第 37 輪第 5 項）
 * 追蹤部位：persons[第幾位]、order_addons、manual_discount、total_override、note
 * order_promos 一律以伺服器端為準，不在前端合併範圍內。
 */

function stableClone(obj) {
  if (obj == null) return obj;
  return JSON.parse(JSON.stringify(obj));
}

function normalizePersonEntry(p = {}) {
  const clean = { ...p };
  return clean;
}

function getPersonMap(draft = {}) {
  const map = new Map();
  for (const p of (Array.isArray(draft?.persons) ? draft.persons : [])) {
    if (p && p.person_no != null) {
      map.set(Number(p.person_no), p);
    }
  }
  return map;
}

function sameJson(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function analyzeDraftConflict({ baseDraft = {}, localDraft = {}, serverDraft = {} }) {
  const baseP = getPersonMap(baseDraft);
  const localP = getPersonMap(localDraft);
  const serverP = getPersonMap(serverDraft);
  const allPersonNos = Array.from(new Set([...baseP.keys(), ...localP.keys(), ...serverP.keys()])).sort((a, b) => a - b);

  const dirtyPersonNos = [];
  const bothChangedLabels = [];
  const localChangedLabels = [];

  for (const pNo of allPersonNos) {
    const bp = baseP.get(pNo) || null;
    const lp = localP.get(pNo) || null;
    const sp = serverP.get(pNo) || null;
    const localChanged = !sameJson(bp, lp);
    const serverChanged = !sameJson(bp, sp);
    if (localChanged) {
      dirtyPersonNos.push(pNo);
      localChangedLabels.push(`第 ${pNo} 位設定`);
      if (serverChanged) {
        bothChangedLabels.push(`第 ${pNo} 位設定`);
      }
    }
  }

  const sections = [
    { key: 'order_addons', label: '整單加購' },
    { key: 'manual_discount', label: '手動折讓' },
    { key: 'total_override', label: '直接改應收金額' },
    { key: 'note', label: '備註' }
  ];

  const dirtySections = {};
  for (const sec of sections) {
    const bv = sec.key === 'note' ? (baseDraft?.[sec.key] || '') : (baseDraft?.[sec.key] ?? null);
    const lv = sec.key === 'note' ? (localDraft?.[sec.key] || '') : (localDraft?.[sec.key] ?? null);
    const sv = sec.key === 'note' ? (serverDraft?.[sec.key] || '') : (serverDraft?.[sec.key] ?? null);
    const localChanged = !sameJson(bv, lv);
    const serverChanged = !sameJson(bv, sv);
    dirtySections[sec.key] = localChanged;
    if (localChanged) {
      localChangedLabels.push(sec.label);
      if (serverChanged) {
        bothChangedLabels.push(sec.label);
      }
    }
  }

  return {
    dirtyPersonNos,
    dirtySections,
    splitModeChanged: (baseDraft?.split_mode || 'proportional') !== (localDraft?.split_mode || 'proportional'),
    localChangedLabels,
    bothChangedLabels
  };
}

export function mergeDraftConflict({ baseDraft = {}, localDraft = {}, serverDraft = {} }) {
  const analysis = analyzeDraftConflict({ baseDraft, localDraft, serverDraft });
  const merged = stableClone(serverDraft) || {};

  // 1. Merge dirty person_nos only
  const localPMap = getPersonMap(localDraft);
  const mergedPMap = getPersonMap(merged);
  for (const pNo of analysis.dirtyPersonNos) {
    if (localPMap.has(pNo)) {
      mergedPMap.set(pNo, stableClone(normalizePersonEntry(localPMap.get(pNo))));
    } else {
      mergedPMap.delete(pNo);
    }
  }
  merged.persons = Array.from(mergedPMap.values()).sort((a, b) => Number(a.person_no) - Number(b.person_no));

  if (analysis.splitModeChanged) {
    merged.split_mode = localDraft.split_mode || 'proportional';
  }

  // 2. 3-way merge order_addons by key (preserving server's additions alongside local additions)
  if (analysis.dirtySections.order_addons) {
    const baseAddons = Array.isArray(baseDraft?.order_addons) ? baseDraft.order_addons : [];
    const localAddons = Array.isArray(localDraft?.order_addons) ? localDraft.order_addons : [];
    const serverAddons = Array.isArray(merged.order_addons) ? [...merged.order_addons] : [];

    const baseByKey = new Map(baseAddons.map(a => [a.key, a]));
    const localByKey = new Map(localAddons.map(a => [a.key, a]));

    // Remove items deleted locally, apply qty delta on items present in both base & local
    const nextAddons = [];
    for (const sa of serverAddons) {
      const ba = baseByKey.get(sa.key);
      const la = localByKey.get(sa.key);
      if (ba && !la) {
        continue; // Deleted locally
      }
      if (ba && la) {
        const qtyDelta = (Number(la.qty) || 0) - (Number(ba.qty) || 0);
        const nextQty = (Number(sa.qty) || 0) + qtyDelta;
        if (nextQty > 0) {
          nextAddons.push({ ...la, ...sa, qty: nextQty, split_mode: la.split_mode ?? sa.split_mode, target_person_no: la.target_person_no ?? sa.target_person_no });
        }
        continue;
      }
      nextAddons.push(sa);
    }

    // Append newly added local items (not in base)
    for (const la of localAddons) {
      if (!baseByKey.has(la.key)) {
        const existingIdx = nextAddons.findIndex(
          a => a.name === la.name && Boolean(a.added_after_payment) === Boolean(la.added_after_payment) && (a.split_mode || 'proportional') === (la.split_mode || 'proportional') && (a.target_person_no ?? null) === (la.target_person_no ?? null)
        );
        if (existingIdx >= 0) {
          nextAddons[existingIdx] = {
            ...nextAddons[existingIdx],
            qty: (Number(nextAddons[existingIdx].qty) || 0) + (Number(la.qty) || 1)
          };
        } else {
          nextAddons.push(stableClone(la));
        }
      }
    }

    merged.order_addons = nextAddons;
  }

  // 3. Other dirty single-value sections
  if (analysis.dirtySections.manual_discount) {
    merged.manual_discount = stableClone(localDraft.manual_discount ?? null);
  }
  if (analysis.dirtySections.total_override) {
    merged.total_override = stableClone(localDraft.total_override ?? null);
  }
  if (analysis.dirtySections.note) {
    merged.note = localDraft.note ?? '';
  }

  // order_promos always stays strictly on serverDraft
  merged.order_promos = stableClone(serverDraft?.order_promos || []);
  merged.rev = serverDraft?.rev ?? merged.rev ?? 0;

  return merged;
}
