export function tapSlot(sel, idx, { usable, linked }) {
  if (!usable(idx)) return { sel, reason: 'unusable' };
  if (!sel) return { sel: { start: idx, end: idx } };
  const { start, end } = sel;
  if (idx >= start && idx <= end) {
    if (start === end) return { sel: null };
    if (idx === start) return { sel: { start: start + 1, end } };
    if (idx === end) return { sel: { start, end: end - 1 } };
    return { sel: { start, end: idx } };
  }
  const [from, to] = idx < start ? [idx, start - 1] : [end + 1, idx];
  let fillable = true;
  for (let k = from; k <= to; k++) {
    if (!usable(k)) fillable = false;
  }
  for (let k = Math.min(idx, start); k < Math.max(idx, end); k++) {
    if (!linked(k)) fillable = false;
  }
  if (!fillable) return { sel: { start: idx, end: idx } };
  return { sel: idx < start ? { start: idx, end } : { start, end: idx } };
}

export function buildUnlimitedOptions(sessions, { N, usable, linked, isPast }) {
  const count = sessions.length;
  // run[i]：從第 i 格開始，連續可選（且時間相連）的格數
  const run = new Array(count + 1).fill(0);
  for (let i = count - 1; i >= 0; i--) {
    run[i] = usable(i) ? 1 + (i < count - 1 && linked(i) ? run[i + 1] : 0) : 0;
  }
  const first = sessions.findIndex((s, i) => !isPast(i));
  if (first === -1) return { arrivals: [], leavesFor: () => [] };
  const lastShown = Math.min(count - 1, count - N + 2);
  const arrivals = [];
  for (let i = first; i <= lastShown; i++) {
    arrivals.push({ index: i, time: sessions[i].start_time, enabled: run[i] >= N });
  }
  const leavesFor = (i) => {
    const out = [];
    for (let j = Math.max(i + 1, i + N - 2); j <= count; j++) {
      out.push({
        endIndex: j,
        time: sessions[j - 1].end_time,
        isClosing: j === count,
        enabled: j >= i + N && j <= i + run[i],
      });
    }
    return out;
  };
  return { arrivals, leavesFor };
}

export function transitionMode({
  currentMode,
  targetMode,
  sel = null,
  arrival = null,
  leave = null,
  lastTimedSel = null,
  lastUnlimited = null,
  N = 4,
  unlimitedOptions = { arrivals: [], leavesFor: () => [] }
}) {
  if (targetMode === currentMode) {
    return { mode: currentMode, sel, arrival, leave, lastTimedSel, lastUnlimited };
  }

  if (targetMode === 'unlimited') {
    // Save current timed selection
    const savedTimedSel = sel;

    // Pick arrival
    let newArrival = null;
    const validArrivals = (unlimitedOptions?.arrivals || []).filter(a => a.enabled);

    if (lastUnlimited?.arrival != null && validArrivals.some(a => a.index === lastUnlimited.arrival)) {
      newArrival = lastUnlimited.arrival;
    } else if (savedTimedSel?.start != null && validArrivals.some(a => a.index === savedTimedSel.start)) {
      newArrival = savedTimedSel.start;
    } else if (validArrivals.length > 0) {
      newArrival = validArrivals[0].index;
    }

    // Pick leave
    let newLeave = null;
    if (newArrival != null) {
      const validLeaves = (unlimitedOptions?.leavesFor ? unlimitedOptions.leavesFor(newArrival) : []).filter(l => l.enabled);
      const defaultLeaveIndex = newArrival + N;

      if (lastUnlimited?.leave != null && validLeaves.some(l => l.endIndex === lastUnlimited.leave)) {
        newLeave = lastUnlimited.leave;
      } else if (savedTimedSel?.end != null && (savedTimedSel.end + 1) > defaultLeaveIndex && validLeaves.some(l => l.endIndex === savedTimedSel.end + 1)) {
        newLeave = savedTimedSel.end + 1;
      } else if (validLeaves.some(l => l.endIndex === defaultLeaveIndex)) {
        newLeave = defaultLeaveIndex;
      } else if (validLeaves.length > 0) {
        newLeave = validLeaves[0].endIndex;
      }
    }

    const updatedUnlimited = (newArrival != null && newLeave != null)
      ? { arrival: newArrival, leave: newLeave }
      : lastUnlimited;

    return {
      mode: 'unlimited',
      sel: null,
      arrival: newArrival,
      leave: newLeave,
      lastTimedSel: savedTimedSel,
      lastUnlimited: updatedUnlimited
    };
  }

  if (targetMode === 'timed') {
    // Save current unlimited selection
    const updatedUnlimited = (arrival != null && leave != null)
      ? { arrival, leave }
      : lastUnlimited;

    // Restore timed selection if previously chosen; if never chosen, return null
    const restoredSel = lastTimedSel != null ? lastTimedSel : null;

    return {
      mode: 'timed',
      sel: restoredSel,
      arrival: null,
      leave: null,
      lastTimedSel,
      lastUnlimited: updatedUnlimited
    };
  }

  return { mode: targetMode, sel, arrival, leave, lastTimedSel, lastUnlimited };
}
