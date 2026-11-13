import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Layers,
  Save,
  Send,
  Plus,
  Trash2,
  RotateCw,
  Eye,
  Sliders,
  Check,
  AlertCircle,
  X,
  Undo2,
  Redo2,
  Copy,
  Move,
  Grid,
  Maximize2,
  Image as ImageIcon,
  PenTool,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignHorizontalJustifyCenter,
  ZoomIn,
  ZoomOut,
  Lock,
  Unlock,
  ChevronDown,
  ChevronRight,
  Split,
  Square,
  Circle,
  DoorOpen,
  Store,
  Columns,
  AlertTriangle,
  GripVertical,
  ArrowUp,
  ArrowDown,
  Smartphone
} from 'lucide-react';
import api from '../../api/axios';
import SegmentedTabs from '../../components/admin/SegmentedTabs';
import ResponsivePanel from '../../components/admin/ResponsivePanel';
import ConfirmPanel from '../../components/admin/ConfirmPanel';
import Button from '../../components/customer/Button';

const DEFAULT_WEIGHTS = {
  zone: 1,
  zone_fill_first: 50,
  opposite: 3,
  beside: 6,
  second: 20,
  last: 100,
  split: 4
};

export default function SeatLayoutPage() {
  const [activeTab, setActiveTab] = useState(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      return 'mobile_list';
    }
    return 'editor';
  });
  const [layout, setLayout] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  // Rules state
  const [layoutRules, setLayoutRules] = useState({
    spread_tables: true,
    avoid_opposite: true,
    avoid_beside: true,
    zone_mode: 'empty_tables_first',
    weights: { ...DEFAULT_WEIGHTS }
  });
  const [zoneOrderList, setZoneOrderList] = useState([]);
  const [showAdvancedWeights, setShowAdvancedWeights] = useState(false);
  const [draggedZoneIdx, setDraggedZoneIdx] = useState(null);
  const [savingRules, setSavingRules] = useState(false);
  const [isAddingZone, setIsAddingZone] = useState(false);
  const [newZoneName, setNewZoneName] = useState('');
  const [editingZoneId, setEditingZoneId] = useState(null);
  const [editingZoneName, setEditingZoneName] = useState('');
  const [zoneError, setZoneError] = useState('');

  // History for Undo / Redo (up to 50 steps)
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Selection state
  const [selectedTableId, setSelectedTableId] = useState(null);
  const [selectedSeatCode, setSelectedSeatCode] = useState(null);
  const [selectedElementId, setSelectedElementId] = useState(null);
  const [selectedTableIds, setSelectedTableIds] = useState([]);
  const [selectedSeatCodes, setSelectedSeatCodes] = useState([]);
  const multiSelectedTableIds = selectedTableIds;

  // Editor tools & preferences
  const [activeTool, setActiveTool] = useState('select'); // 'select' | 'draw_wall' | 'draw_window' | 'draw_zone'
  const [gridSnap, setGridSnap] = useState(true);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [currentZoneId, setCurrentZoneId] = useState(null);

  // In-progress drawing points (e.g. wall or window)
  const [drawingPoints, setDrawingPoints] = useState([]);
  const [cursorPos, setCursorPos] = useState(null);

  // Dragging state
  const [dragInfo, setDragInfo] = useState(null);
  // Marquee selection
  const [marquee, setMarquee] = useState(null);

  // Publish modal state
  const [previewPublishData, setPreviewPublishData] = useState(null);
  const [showPublishConfirm, setShowPublishConfirm] = useState(false);
  const [publishDate, setPublishDate] = useState(() => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }));
  const [manualOverrides, setManualOverrides] = useState({});
  const [editingOverrideRef, setEditingOverrideRef] = useState(null);

  // Allocation test state
  const [testPax, setTestPax] = useState(2);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  // Mobile sheet for seat property edit
  const [mobileEditingSeat, setMobileEditingSeat] = useState(null);

  const svgRef = useRef(null);
  const fileInputRef = useRef(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const zoneOrderListRef = useRef(zoneOrderList);
  zoneOrderListRef.current = zoneOrderList;
  const currentZoneIdRef = useRef(currentZoneId);
  currentZoneIdRef.current = currentZoneId;

  const syncLayoutFromServer = useCallback((rawLayout) => {
    if (!rawLayout) return null;
    const normalized = { ...rawLayout };
    if (!normalized.elements_json && normalized.elements) {
      normalized.elements_json = normalized.elements;
    }
    if (!Array.isArray(normalized.elements_json)) {
      normalized.elements_json = [];
    }
    const sortedZones = Array.isArray(normalized.zones)
      ? [...normalized.zones].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      : [];

    const prevZones = zoneOrderListRef.current || [];
    const prevSelectedId = currentZoneIdRef.current;
    const prevIdx = prevZones.findIndex(z => z.id === prevSelectedId);
    const prevSelected = prevIdx >= 0 ? prevZones[prevIdx] : (layoutRef.current?.zones || []).find(z => z.id === prevSelectedId);

    let nextZoneId = null;
    if (sortedZones.length > 0) {
      if (prevSelected) {
        const byName = sortedZones.find(z => z.name === prevSelected.name);
        if (byName) {
          nextZoneId = byName.id;
        } else if (prevIdx >= 0 && sortedZones[prevIdx]) {
          nextZoneId = sortedZones[prevIdx].id;
        } else {
          nextZoneId = sortedZones[0].id;
        }
      } else {
        nextZoneId = sortedZones[0].id;
      }
    }

    layoutRef.current = normalized;
    zoneOrderListRef.current = sortedZones;
    currentZoneIdRef.current = nextZoneId;

    setLayout(normalized);
    setZoneOrderList(sortedZones);
    setCurrentZoneId(nextZoneId);
    return { normalized, sortedZones, nextZoneId };
  }, []);

  // 1. Initial Load
  useEffect(() => {
    fetchLayout();
  }, []);

  const fetchLayout = async () => {
    try {
      setLoading(true);
      // Check if there is an existing draft
      const listRes = await api.get('/seat-layouts');
      const draft = listRes.data?.layouts?.find(l => l.status === 'draft');
      let loadedLayout = null;
      if (draft) {
        const res = await api.get(`/seat-layouts/${draft.id}`);
        loadedLayout = res.data.layout;
      } else {
        const todayTaipei = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
        const activeRes = await api.get('/seat-layouts/active', { params: { date: todayTaipei } });
        loadedLayout = activeRes.data;
      }

      if (loadedLayout) {
        const synced = syncLayoutFromServer(loadedLayout);
        const normalized = synced?.normalized || loadedLayout;
        setHistory([JSON.parse(JSON.stringify(normalized))]);
        setHistoryIndex(0);
        if (normalized.rules_json) {
          setLayoutRules({
            spread_tables: normalized.rules_json.spread_tables !== false,
            avoid_opposite: normalized.rules_json.avoid_opposite !== false,
            avoid_beside: normalized.rules_json.avoid_beside !== false,
            zone_mode: (normalized.rules_json.zone_mode === 'spread_across_zones' || !normalized.rules_json.zone_mode)
              ? 'empty_tables_first'
              : normalized.rules_json.zone_mode,
            weights: {
              ...DEFAULT_WEIGHTS,
              ...(normalized.rules_json.weights || {})
            }
          });
        }
      }
    } catch (err) {
      console.error(err);
      setMessage({ type: 'error', text: '載入版面失敗' });
    } finally {
      setLoading(false);
    }
  };

  // Push new state to undo/redo history
  const commitLayoutChange = useCallback((newLayout) => {
    const target = newLayout || layoutRef.current;
    if (!target) return;
    const cloned = JSON.parse(JSON.stringify(target));

    // Guard against identical commits
    if (history.length > 0 && historyIndex >= 0 && historyIndex < history.length) {
      const currentHead = history[historyIndex];
      if (
        JSON.stringify(currentHead.zones) === JSON.stringify(cloned.zones) &&
        JSON.stringify(currentHead.tables) === JSON.stringify(cloned.tables) &&
        JSON.stringify(currentHead.seats) === JSON.stringify(cloned.seats) &&
        JSON.stringify(currentHead.elements_json) === JSON.stringify(cloned.elements_json) &&
        JSON.stringify(currentHead.rules_json) === JSON.stringify(cloned.rules_json) &&
        currentHead.canvas_w === cloned.canvas_w &&
        currentHead.canvas_h === cloned.canvas_h &&
        currentHead.background_image === cloned.background_image &&
        currentHead.background_opacity === cloned.background_opacity
      ) {
        return;
      }
    }

    setHistory(prev => {
      const next = prev.slice(0, historyIndex + 1);
      if (next.length >= 50) next.shift();
      next.push(cloned);
      return next;
    });
    setHistoryIndex(prev => Math.min(prev + 1, 49));
    setLayout(cloned);
    if (Array.isArray(cloned.zones)) {
      const sorted = [...cloned.zones].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      setZoneOrderList(sorted);
    }
  }, [historyIndex, history]);

  // Undo
  const handleUndo = useCallback(() => {
    if (historyIndex > 0) {
      const targetIndex = historyIndex - 1;
      const targetLayout = JSON.parse(JSON.stringify(history[targetIndex]));
      setHistoryIndex(targetIndex);
      setLayout(targetLayout);
      if (Array.isArray(targetLayout.zones)) {
        setZoneOrderList([...targetLayout.zones].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)));
      }
      setMessage({ type: 'info', text: '已復原' });
    }
  }, [historyIndex, history]);

  // Redo
  const handleRedo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const targetIndex = historyIndex + 1;
      const targetLayout = JSON.parse(JSON.stringify(history[targetIndex]));
      setHistoryIndex(targetIndex);
      setLayout(targetLayout);
      if (Array.isArray(targetLayout.zones)) {
        setZoneOrderList([...targetLayout.zones].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)));
      }
      setMessage({ type: 'info', text: '已重做' });
    }
  }, [historyIndex, history]);

  // Keyboard shortcuts: Ctrl+Z / Ctrl+Y
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (e.shiftKey) {
          e.preventDefault();
          handleRedo();
        } else {
          e.preventDefault();
          handleUndo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // If an input/textarea is focused, do not delete
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
        if (selectedTableId) {
          handleDeleteTable(selectedTableId);
        } else if (selectedElementId) {
          handleDeleteElement(selectedElementId);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo, selectedTableId, selectedElementId]);

  // Save Draft to Backend
  const handleSaveDraft = async () => {
    const current = layoutRef.current || layout;
    if (!current) return;
    try {
      setSaving(true);

      // Ensure bidirectional link for adjacent_codes and opposite_codes
      const seatMap = new Map((current.seats || []).map(s => [s.code, s]));
      for (const s of current.seats || []) {
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

      let targetId = current.id;
      // If active layout is published or legacy (id: 0), create draft on backend first
      if (current.status === 'published' || !targetId) {
        const draftRes = await api.post('/seat-layouts/draft', { from_id: targetId || undefined });
        targetId = draftRes.data.layout_id;
      }
      const zonesPayload = (zoneOrderListRef.current.length > 0 ? zoneOrderListRef.current : (current.zones || []))
        .map((z, idx) => ({ ...z, sort_order: idx }));
      const payloadToSave = { ...current, zones: zonesPayload };
      const res = await api.put(`/seat-layouts/${targetId}`, payloadToSave);
      if (res.data?.layout) {
        syncLayoutFromServer(res.data.layout);
      } else {
        setLayout(prev => ({ ...prev, id: targetId, status: 'draft' }));
      }
      setMessage({ type: 'success', text: '草稿儲存成功！' });
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || '儲存失敗' });
    } finally {
      setSaving(false);
    }
  };

  const getZoneTableSummary = (zoneId) => {
    const zTables = (layout?.tables || []).filter(t => t.zone_id === zoneId);
    if (zTables.length === 0) return '0 張桌子';
    const capCounts = {};
    for (const t of zTables) {
      const tSeats = (layout?.seats || []).filter(s => s.table_id === t.id);
      const cap = tSeats.length || t.seat_count || 4;
      capCounts[cap] = (capCounts[cap] || 0) + 1;
    }
    return Object.entries(capCounts)
      .map(([cap, count]) => `${count} 張 ${cap} 人桌`)
      .join('、');
  };

  // Allocation test handler
  const handleTestAllocation = async (paxToTest = testPax, rulesToTest = layoutRules, zonesToTest = zoneOrderList) => {
    if (!layout) return;
    try {
      setTesting(true);
      const resolvedZones = (zonesToTest || []).map((z, idx) => ({ ...z, sort_order: idx }));
      const previewLayout = {
        ...layout,
        zones: resolvedZones
      };
      const res = await api.post('/seat-layouts/allocate-preview', {
        layout_id: layout.id,
        draft: previewLayout,
        rules: rulesToTest,
        pax: paxToTest,
        demo: true,
        date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' })
      });
      setTestResult(res.data);
      return res.data;
    } catch (err) {
      console.error(err);
      setMessage({ type: 'error', text: '排位試算失敗' });
    } finally {
      setTesting(false);
    }
  };

  const getNextDefaultZoneName = (zones = []) => {
    const existingNames = new Set(zones.map(z => (z.name || '').trim()));
    let code = 65 + zones.length;
    if (code > 90) code = 65;
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + ((code - 65 + i) % 26));
      const candidate = `${letter} 區`;
      if (!existingNames.has(candidate)) return candidate;
    }
    return `區域 ${zones.length + 1}`;
  };

  const handleStartAddZone = () => {
    setZoneError('');
    setEditingZoneId(null);
    setNewZoneName(getNextDefaultZoneName(zoneOrderList));
    setIsAddingZone(true);
  };

  const handleConfirmAddZone = () => {
    const trimmed = newZoneName.trim();
    if (trimmed.length < 1 || trimmed.length > 10) {
      setZoneError('區域名稱需為 1～10 個字');
      return;
    }
    if (zoneOrderList.some(z => (z.name || '').trim() === trimmed)) {
      setZoneError('區域名稱不能重複');
      return;
    }
    let nextTempId = -Date.now();
    while (zoneOrderList.some(z => z.id === nextTempId)) {
      nextTempId--;
    }
    const nextZone = {
      id: nextTempId,
      name: trimmed,
      sort_order: zoneOrderList.length,
      note: null,
      polygon: null
    };
    const nextList = [...zoneOrderList, nextZone].map((z, idx) => ({ ...z, sort_order: idx }));
    setZoneOrderList(nextList);
    commitLayoutChange({ ...layout, zones: nextList });
    setIsAddingZone(false);
    setNewZoneName('');
    setZoneError('');
  };

  const handleStartRenameZone = (zone) => {
    setZoneError('');
    setIsAddingZone(false);
    setEditingZoneId(zone.id);
    setEditingZoneName(zone.name || '');
  };

  const handleConfirmRenameZone = (zoneId) => {
    const trimmed = editingZoneName.trim();
    if (trimmed.length < 1 || trimmed.length > 10) {
      setZoneError('區域名稱需為 1～10 個字');
      return;
    }
    if (zoneOrderList.some(z => z.id !== zoneId && (z.name || '').trim() === trimmed)) {
      setZoneError('區域名稱不能重複');
      return;
    }
    const nextList = zoneOrderList.map((z, idx) => z.id === zoneId ? { ...z, name: trimmed, sort_order: idx } : { ...z, sort_order: idx });
    setZoneOrderList(nextList);
    commitLayoutChange({ ...layout, zones: nextList });
    setEditingZoneId(null);
    setEditingZoneName('');
    setZoneError('');
  };

  const handleDeleteZone = (zoneId) => {
    if (zoneOrderList.length <= 1) return;
    const hasItems = (layout?.tables || []).some(t => t.zone_id === zoneId) ||
      (layout?.seats || []).some(s => s.zone_id === zoneId);
    if (hasItems) return;

    const nextList = zoneOrderList
      .filter(z => z.id !== zoneId)
      .map((z, idx) => ({ ...z, sort_order: idx }));
    setZoneOrderList(nextList);
    if (currentZoneId === zoneId && nextList.length > 0) {
      setCurrentZoneId(nextList[0].id);
    }
    commitLayoutChange({ ...layout, zones: nextList });
    setZoneError('');
  };

  const moveZone = (fromIdx, toIdx) => {
    if (toIdx < 0 || toIdx >= zoneOrderList.length) return;
    const nextList = [...zoneOrderList];
    const [removed] = nextList.splice(fromIdx, 1);
    nextList.splice(toIdx, 0, removed);
    const ordered = nextList.map((z, idx) => ({ ...z, sort_order: idx }));
    setZoneOrderList(ordered);
    setLayout(prev => prev ? { ...prev, zones: ordered } : prev);
    handleTestAllocation(testPax, layoutRules, ordered);
  };

  useEffect(() => {
    if (activeTab === 'rules' && layout && !testResult && !testing) {
      handleTestAllocation(testPax, layoutRules, zoneOrderList);
    }
  }, [activeTab, layout]);

  const handleSaveRules = async () => {
    if (!layout?.id) return;
    try {
      setSavingRules(true);
      const res = await api.put(`/seat-layouts/${layout.id}/rules`, {
        rules_json: layoutRules,
        zone_order: zoneOrderList.map(z => z.id)
      });
      if (res.data?.layout) {
        syncLayoutFromServer(res.data.layout);
      } else {
        const refreshed = await api.get(`/seat-layouts/${layout.id}`);
        if (refreshed.data?.layout) {
          syncLayoutFromServer(refreshed.data.layout);
        }
      }
      setMessage({ type: 'success', text: '排位規則已儲存並生效！' });
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || '儲存排位規則失敗' });
    } finally {
      setSavingRules(false);
    }
  };

  // Preview Publish & Confirm Publish
  const handlePreviewPublish = async () => {
    if (!layout || !layout.id) return;
    try {
      setSaving(true);
      const res = await api.post(`/seat-layouts/${layout.id}/preview-publish`, {
        effective_from: publishDate
      });
      setPreviewPublishData(res.data);
      setShowPublishConfirm(true);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || '影響評估失敗' });
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmPublish = async () => {
    try {
      setSaving(true);
      const res = await api.post(`/seat-layouts/${layout.id}/publish`, {
        effective_from: publishDate,
        confirm: true,
        manual_overrides: manualOverrides
      });
      setShowPublishConfirm(false);
      if (res.data?.category_c?.length > 0 || res.data?.in_store_reseat?.length > 0) {
        const catC = res.data.category_c || res.data.in_store_reseat;
        const existingHints = JSON.parse(sessionStorage.getItem('sg_reseated_c_hints') || '{}');
        for (const c of catC) {
          const fromStr = (c.from || []).join('、');
          const toStr = (manualOverrides[c.booking_ref] || c.to || []).join('、');
          existingHints[c.booking_ref] = { from: fromStr, to: toStr };
        }
        sessionStorage.setItem('sg_reseated_c_hints', JSON.stringify(existingHints));
      }
      if (res.data?.layout) {
        syncLayoutFromServer(res.data.layout);
      } else {
        setLayout(prev => ({ ...prev, status: 'published', effective_from: publishDate }));
      }
      setMessage({ type: 'success', text: '版面發布成功！' });
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || '發布失敗' });
    } finally {
      setSaving(false);
    }
  };

  // Canvas Coordinates Helper
  const getCanvasCoords = useCallback((e) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const transformed = pt.matrixTransform(svg.getScreenCTM().inverse());
    let x = Math.round(transformed.x);
    let y = Math.round(transformed.y);
    return { x, y };
  }, []);

  const snapValue = useCallback((val, step = 10) => {
    if (!gridSnap) return val;
    const gs = layout?.grid_size || step;
    return Math.round(val / gs) * gs;
  }, [gridSnap, layout?.grid_size]);

  // Selected entities
  const selectedTable = useMemo(() => {
    return (layout?.tables || []).find(t => t.id === selectedTableId) || null;
  }, [layout?.tables, selectedTableId]);

  const selectedSeat = useMemo(() => {
    return (layout?.seats || []).find(s => s.code === selectedSeatCode) || null;
  }, [layout?.seats, selectedSeatCode]);

  const selectedElement = useMemo(() => {
    return (layout?.elements_json || []).find(el => el.id === selectedElementId) || null;
  }, [layout?.elements_json, selectedElementId]);

  // Pointer Events on SVG
  const handlePointerDown = (e) => {
    if (!layout) return;
    const { x, y } = getCanvasCoords(e);

    // If drawing wall or window
    if (activeTool === 'draw_wall' || activeTool === 'draw_window') {
      const snappedX = snapValue(x);
      const snappedY = snapValue(y);
      setDrawingPoints(prev => [...prev, [snappedX, snappedY]]);
      return;
    }

    // If clicking on empty canvas, start marquee or deselect
    const isInteractive = e.target.closest('[data-testid^="table-node-"]') ||
      e.target.closest('[data-testid^="seat-node-"]') ||
      e.target.closest('polyline') ||
      e.target.closest('g[cursor="move"]') ||
      e.target.closest('g[cursor="grab"]');

    if (!isInteractive) {
      if (!e.shiftKey) {
        setSelectedTableId(null);
        setSelectedSeatCode(null);
        setSelectedElementId(null);
        setSelectedTableIds([]);
        setSelectedSeatCodes([]);
      }
      setMarquee({ startX: x, startY: y, currentX: x, currentY: y, shiftKey: e.shiftKey });
    }
  };

  const handlePointerMove = (e) => {
    const { x, y } = getCanvasCoords(e);
    setCursorPos({ x, y });

    // Handle Marquee
    if (marquee) {
      setMarquee(prev => ({ ...prev, currentX: x, currentY: y }));
      return;
    }

    // Handle Dragging
    if (!dragInfo) return;

    if (Math.abs(x - dragInfo.startX) > 3 || Math.abs(y - dragInfo.startY) > 3) {
      dragInfo.hasMoved = true;
    }

    if (dragInfo.mode === 'move_selection') {
      const dx = x - dragInfo.startX;
      const dy = y - dragInfo.startY;

      setLayout(prev => {
        const updatedTables = prev.tables.map(t => {
          const init = dragInfo.initTables.find(it => it.id === t.id);
          if (!init) return t;
          return {
            ...t,
            cx: snapValue(init.cx + dx),
            cy: snapValue(init.cy + dy)
          };
        });

        const updatedSeats = prev.seats.map(s => {
          const init = dragInfo.initSeats.find(is => is.code === s.code);
          if (!init) return s;
          return {
            ...s,
            lx: snapValue(init.lx + dx),
            ly: snapValue(init.ly + dy)
          };
        });

        return {
          ...prev,
          tables: updatedTables,
          seats: updatedSeats
        };
      });
    } else if (dragInfo.mode === 'move_table') {
      const dx = x - dragInfo.startX;
      const dy = y - dragInfo.startY;
      const newCx = snapValue(dragInfo.initCx + dx);
      const newCy = snapValue(dragInfo.initCy + dy);

      setLayout(prev => ({
        ...prev,
        tables: prev.tables.map(t => t.id === dragInfo.tableId ? { ...t, cx: newCx, cy: newCy } : t)
      }));
    } else if (dragInfo.mode === 'rotate_table') {
      const { cx, cy } = dragInfo;
      const rawAngle = Math.atan2(y - cy, x - cx) * (180 / Math.PI) + 90;
      let rot = Math.round(rawAngle) % 360;
      if (rot > 180) rot -= 360;
      if (rot < -180) rot += 360;
      if (e.shiftKey) {
        rot = Math.round(rot / 15) * 15;
      }
      setLayout(prev => ({
        ...prev,
        tables: prev.tables.map(t => t.id === dragInfo.tableId ? { ...t, rotation: rot } : t)
      }));
    } else if (dragInfo.mode === 'resize_table') {
      const dx = x - dragInfo.startX;
      const dy = y - dragInfo.startY;
      const newW = Math.max(30, snapValue(dragInfo.initW + (dragInfo.handle.includes('e') ? dx : 0)));
      const newH = Math.max(30, snapValue(dragInfo.initH + (dragInfo.handle.includes('s') ? dy : 0)));

      setLayout(prev => ({
        ...prev,
        tables: prev.tables.map(t => t.id === dragInfo.tableId ? { ...t, w: newW, h: newH } : t)
      }));
    } else if (dragInfo.mode === 'move_seat') {
      const { table, seatCode } = dragInfo;
      if (!table) {
        // Standalone seat move
        const dx = x - dragInfo.startX;
        const dy = y - dragInfo.startY;
        const newLx = snapValue(dragInfo.initLx + dx);
        const newLy = snapValue(dragInfo.initLy + dy);
        setLayout(prev => ({
          ...prev,
          seats: prev.seats.map(s => s.code === seatCode ? { ...s, lx: newLx, ly: newLy } : s)
        }));
      } else {
        // Offset relative to table center
        const dx = x - table.cx;
        const dy = y - table.cy;
        // Unrotate
        const rad = (-table.rotation * Math.PI) / 180;
        const unrotLx = dx * Math.cos(rad) - dy * Math.sin(rad);
        const unrotLy = dx * Math.sin(rad) + dy * Math.cos(rad);

        const newLx = snapValue(Math.round(unrotLx), 5);
        const newLy = snapValue(Math.round(unrotLy), 5);

        setLayout(prev => ({
          ...prev,
          seats: prev.seats.map(s => s.code === seatCode ? { ...s, lx: newLx, ly: newLy } : s)
        }));
      }
    } else if (dragInfo.mode === 'move_element') {
      const dx = x - dragInfo.startX;
      const dy = y - dragInfo.startY;
      const newX = snapValue(dragInfo.initX + dx);
      const newY = snapValue(dragInfo.initY + dy);

      setLayout(prev => ({
        ...prev,
        elements_json: prev.elements_json.map(el => el.id === dragInfo.elementId ? { ...el, x: newX, y: newY } : el)
      }));
    }
  };

  const handlePointerUp = () => {
    // End Marquee
    if (marquee) {
      const minX = Math.min(marquee.startX, marquee.currentX);
      const maxX = Math.max(marquee.startX, marquee.currentX);
      const minY = Math.min(marquee.startY, marquee.currentY);
      const maxY = Math.max(marquee.startY, marquee.currentY);

      if (Math.abs(maxX - minX) > 10 || Math.abs(maxY - minY) > 10) {
        const boxedTableIds = (layout?.tables || []).filter(t => {
          return t.cx >= minX && t.cx <= maxX && t.cy >= minY && t.cy <= maxY;
        }).map(t => t.id);

        const boxedSeatCodes = (layout?.seats || []).filter(s => {
          if (s.table_id != null) return false;
          return s.lx >= minX && s.lx <= maxX && s.ly >= minY && s.ly <= maxY;
        }).map(s => s.code);

        let newTableIds = boxedTableIds;
        let newSeatCodes = boxedSeatCodes;

        if (marquee.shiftKey) {
          newTableIds = Array.from(new Set([...selectedTableIds, ...boxedTableIds]));
          newSeatCodes = Array.from(new Set([...selectedSeatCodes, ...boxedSeatCodes]));
        }

        setSelectedTableIds(newTableIds);
        setSelectedSeatCodes(newSeatCodes);

        if (newTableIds.length === 1 && newSeatCodes.length === 0) {
          setSelectedTableId(newTableIds[0]);
          setSelectedSeatCode(null);
        } else if (newSeatCodes.length === 1 && newTableIds.length === 0) {
          setSelectedSeatCode(newSeatCodes[0]);
          setSelectedTableId(null);
        } else {
          setSelectedTableId(null);
          setSelectedSeatCode(null);
        }
      }
      setMarquee(null);
    }

    // End Drag
    if (dragInfo) {
      if (dragInfo.mode === 'move_selection' && !dragInfo.hasMoved) {
        if (dragInfo.tableId) {
          setSelectedTableId(dragInfo.tableId);
          setSelectedTableIds([dragInfo.tableId]);
          setSelectedSeatCode(null);
          setSelectedSeatCodes([]);
        } else if (dragInfo.seatCode) {
          setSelectedSeatCode(dragInfo.seatCode);
          setSelectedSeatCodes([dragInfo.seatCode]);
          setSelectedTableId(null);
          setSelectedTableIds([]);
        }
      } else if (dragInfo.hasMoved) {
        commitLayoutChange();
      }
      setDragInfo(null);
    }
  };

  // Finish Drawing Tool
  const handleFinishDrawing = () => {
    if (drawingPoints.length < 2) {
      setDrawingPoints([]);
      setActiveTool('select');
      return;
    }
    const elemType = activeTool === 'draw_window' ? 'window' : 'wall';
    const newElement = {
      id: `${elemType}_${Date.now()}`,
      type: elemType,
      points: drawingPoints,
      thickness: elemType === 'wall' ? 4 : 3
    };

    const nextElements = [...(layout.elements_json || []), newElement];
    commitLayoutChange({
      ...layout,
      elements_json: nextElements
    });
    setDrawingPoints([]);
    setActiveTool('select');
    setMessage({ type: 'success', text: elemType === 'wall' ? '牆面已建立' : '窗戶已建立' });
  };

  // Preset Addition Handlers
  const handleAddPreset = (type) => {
    if (!layout) return;
    const existingTableLabels = (layout.tables || []).map(t => t.label);
    const existingSeatCodes = (layout.seats || []).map(s => s.code);
    
    // Find next table number / label
    let nextNum = 1;
    while (
      existingTableLabels.includes(String(nextNum)) ||
      existingTableLabels.includes(`桌 ${nextNum}`) ||
      existingSeatCodes.some(c => c.startsWith(`${nextNum}-`))
    ) {
      nextNum++;
    }
    const tableLabel = `桌 ${nextNum}`;
    const tableKey = `table_${Date.now()}`;
    const zoneId = currentZoneId || layout.zones?.[0]?.id || 1;

    let newTable = null;
    let newSeats = [];

    const tblCount = layout.tables?.length || 0;
    const cx = 160 + (tblCount % 4) * 160;
    const cy = 180 + Math.floor(tblCount / 4) * 180;

    if (type === '4p') {
      // 4-person facing table
      newTable = {
        id: Date.now(),
        key: tableKey,
        zone_id: zoneId,
        label: tableLabel,
        shape: 'rect',
        arrangement: 'two_sides',
        cx,
        cy,
        w: 70,
        h: 140,
        rotation: 0,
        sort_order: layout.tables?.length || 0
      };
      newSeats = [
        { code: `${nextNum}-1`, table_id: newTable.id, table_key: tableKey, zone_id: zoneId, lx: -45, ly: -35, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
        { code: `${nextNum}-2`, table_id: newTable.id, table_key: tableKey, zone_id: zoneId, lx: -45, ly: 35, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
        { code: `${nextNum}-3`, table_id: newTable.id, table_key: tableKey, zone_id: zoneId, lx: 45, ly: -35, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 2 },
        { code: `${nextNum}-4`, table_id: newTable.id, table_key: tableKey, zone_id: zoneId, lx: 45, ly: 35, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 3 },
      ];
    } else if (type === 'long') {
      // Long table (one_side)
      newTable = {
        id: Date.now(),
        key: tableKey,
        zone_id: zoneId,
        label: tableLabel,
        shape: 'long',
        arrangement: 'one_side',
        cx,
        cy,
        w: 60,
        h: 260,
        rotation: 0,
        sort_order: layout.tables?.length || 0
      };
      newSeats = [
        { code: `${nextNum}-1`, table_id: newTable.id, table_key: tableKey, zone_id: zoneId, lx: -40, ly: -90, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
        { code: `${nextNum}-2`, table_id: newTable.id, table_key: tableKey, zone_id: zoneId, lx: -40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
        { code: `${nextNum}-3`, table_id: newTable.id, table_key: tableKey, zone_id: zoneId, lx: -40, ly: 30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 2 },
        { code: `${nextNum}-4`, table_id: newTable.id, table_key: tableKey, zone_id: zoneId, lx: -40, ly: 90, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 3 },
      ];
    } else if (type === 'round') {
      // Round table
      newTable = {
        id: Date.now(),
        key: tableKey,
        zone_id: zoneId,
        label: tableLabel,
        shape: 'round',
        arrangement: 'two_sides',
        cx,
        cy,
        w: 120,
        h: 120,
        rotation: 0,
        sort_order: layout.tables?.length || 0
      };
      const r = 45;
      newSeats = [
        { code: `${nextNum}-1`, table_id: newTable.id, table_key: tableKey, zone_id: zoneId, lx: -r, ly: 0, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
        { code: `${nextNum}-2`, table_id: newTable.id, table_key: tableKey, zone_id: zoneId, lx: 0, ly: -r, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
        { code: `${nextNum}-3`, table_id: newTable.id, table_key: tableKey, zone_id: zoneId, lx: r, ly: 0, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 2 },
        { code: `${nextNum}-4`, table_id: newTable.id, table_key: tableKey, zone_id: zoneId, lx: 0, ly: r, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 3 },
      ];
    } else if (type === 'single') {
      // Single seat
      newTable = {
        id: Date.now(),
        key: tableKey,
        zone_id: zoneId,
        label: tableLabel,
        shape: 'rect',
        arrangement: 'one_side',
        cx,
        cy,
        w: 50,
        h: 50,
        rotation: 0,
        sort_order: layout.tables?.length || 0
      };
      newSeats = [
        { code: `${nextNum}-1`, table_id: newTable.id, table_key: tableKey, zone_id: zoneId, lx: 0, ly: 0, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 }
      ];
    } else if (type === 'standalone') {
      // Standalone seat (table_id: null)
      const existingCodes = (layout.seats || []).map(s => s.code);
      let sNum = 1;
      while (existingCodes.includes(`S-${sNum}`)) {
        sNum++;
      }
      const sCode = `S-${sNum}`;
      const zoneId = currentZoneId || layout.zones?.[0]?.id || 1;
      const standaloneCount = (layout.seats || []).filter(s => s.table_id == null).length;
      const newSeat = {
        id: Date.now(),
        code: sCode,
        table_id: null,
        zone_id: zoneId,
        lx: 200 + (standaloneCount % 6) * 60,
        ly: 200 + Math.floor(standaloneCount / 6) * 60,
        side_mode: 'auto',
        priority: 'normal',
        is_active: true,
        adjacent_codes: [],
        opposite_codes: [],
        sort_order: layout.seats?.length || 0,
        origin_code: sCode
      };
      commitLayoutChange({
        ...layout,
        seats: [...(layout.seats || []), newSeat]
      });
      setSelectedSeatCode(sCode);
      setSelectedTableId(null);
      setSelectedTableIds([]);
      setSelectedSeatCodes([sCode]);
      setMessage({ type: 'success', text: `已新增單獨座位 ${sCode}` });
      return;
    }

    if (newTable) {
      commitLayoutChange({
        ...layout,
        tables: [...(layout.tables || []), newTable],
        seats: [...(layout.seats || []), ...newSeats]
      });
      setSelectedTableId(newTable.id);
      setSelectedSeatCode(null);
      setMessage({ type: 'success', text: `已新增 ${tableLabel}` });
    }
  };

  // Add Environmental Rectangles (Door, Counter, Pillar)
  const handleAddEnvRect = (type) => {
    const id = `${type}_${Date.now()}`;
    let el = null;
    if (type === 'door') {
      el = { id, type: 'door', x: 50, y: 150, w: 14, h: 60, rotation: 0, label: '大門' };
    } else if (type === 'counter') {
      el = { id, type: 'counter', x: 120, y: 60, w: 140, h: 55, rotation: 0, label: '服務櫃檯' };
    } else if (type === 'pillar') {
      el = { id, type: 'pillar', x: 280, y: 180, w: 40, h: 40, rotation: 0, label: '柱子' };
    }
    if (el) {
      commitLayoutChange({
        ...layout,
        elements_json: [...(layout.elements_json || []), el]
      });
      setSelectedElementId(id);
      setMessage({ type: 'success', text: `已新增 ${el.label}` });
    }
  };

  // Background Image Upload & Compression
  const handleBgImageUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let { width: w, height: h } = img;
        const maxLen = 1600;
        if (w > maxLen || h > maxLen) {
          if (w > h) {
            h = Math.round((h * maxLen) / w);
            w = maxLen;
          } else {
            w = Math.round((w * maxLen) / h);
            h = maxLen;
          }
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);

        commitLayoutChange({
          ...layout,
          background_image: dataUrl,
          background_opacity: layout.background_opacity || 40,
          background_rect: { x: 0, y: 0, w: layout.canvas_w || 1000, h: layout.canvas_h || 625 },
          background_locked: false
        });
        setMessage({ type: 'success', text: '底圖上傳並壓縮成功' });
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  };

  // Copy & Delete Operations
  const handleCopyTable = (tableId) => {
    const table = (layout.tables || []).find(t => t.id === tableId);
    if (!table) return;

    const newId = Date.now();
    const existingLabels = layout.tables.map(t => t.label);
    let nextNum = 1;
    while (existingLabels.includes(String(nextNum)) || existingLabels.includes(`桌 ${nextNum}`)) {
      nextNum++;
    }
    const newLabel = `桌 ${nextNum}`;

    const newTable = {
      ...table,
      id: newId,
      key: `table_${newId}`,
      label: newLabel,
      cx: table.cx + 30,
      cy: table.cy + 30
    };

    const tableSeats = (layout.seats || []).filter(s => s.table_id === tableId);
    const newSeats = tableSeats.map((s, idx) => ({
      ...s,
      id: Date.now() + idx,
      table_id: newId,
      code: `${nextNum}-${idx + 1}`,
      origin_code: `${nextNum}-${idx + 1}`
    }));

    commitLayoutChange({
      ...layout,
      tables: [...layout.tables, newTable],
      seats: [...layout.seats, ...newSeats]
    });
    setSelectedTableId(newId);
    setSelectedTableIds([newId]);
    setMessage({ type: 'success', text: `已複製為 ${newLabel}` });
  };

  const handleDeleteTable = (tableId) => {
    commitLayoutChange({
      ...layout,
      tables: layout.tables.filter(t => t.id !== tableId),
      seats: layout.seats.filter(s => s.table_id !== tableId)
    });
    setSelectedTableId(null);
    setSelectedTableIds(prev => prev.filter(id => id !== tableId));
    setSelectedSeatCode(null);
    setMessage({ type: 'success', text: '已刪除桌子' });
  };

  const handleDeleteSeat = (seatCode) => {
    commitLayoutChange({
      ...layout,
      seats: (layout.seats || []).filter(s => s.code !== seatCode)
    });
    setSelectedSeatCode(null);
    setSelectedSeatCodes(prev => prev.filter(c => c !== seatCode));
    setMessage({ type: 'success', text: '已刪除座位' });
  };

  const handleDeleteElement = (elementId) => {
    commitLayoutChange({
      ...layout,
      elements_json: (layout.elements_json || []).filter(el => el.id !== elementId)
    });
    setSelectedElementId(null);
    setMessage({ type: 'success', text: '已刪除環境物件' });
  };

  // Multi-selection Batch Operations
  const handleCopySelection = () => {
    const tablesToCopy = (layout.tables || []).filter(t => selectedTableIds.includes(t.id));
    const seatsToCopy = (layout.seats || []).filter(s => s.table_id == null && selectedSeatCodes.includes(s.code));

    let nextTableNum = 1;
    const existingLabels = (layout.tables || []).map(t => t.label);
    const getNextTableLabel = () => {
      while (existingLabels.includes(String(nextTableNum)) || existingLabels.includes(`桌 ${nextTableNum}`)) {
        nextTableNum++;
      }
      const lbl = `桌 ${nextTableNum}`;
      existingLabels.push(lbl);
      return { num: nextTableNum++, label: lbl };
    };

    const newTables = [];
    const newAttachedSeats = [];
    const newTableIds = [];

    for (const origTable of tablesToCopy) {
      const newId = Date.now() + Math.floor(Math.random() * 10000);
      const { num, label } = getNextTableLabel();
      newTableIds.push(newId);
      newTables.push({
        ...origTable,
        id: newId,
        key: `table_${newId}`,
        label,
        cx: origTable.cx + 40,
        cy: origTable.cy + 40
      });

      const attached = (layout.seats || []).filter(s => s.table_id === origTable.id);
      attached.forEach((s, idx) => {
        newAttachedSeats.push({
          ...s,
          id: Date.now() + Math.floor(Math.random() * 100000) + idx,
          table_id: newId,
          table_key: `table_${newId}`,
          code: `${num}-${idx + 1}`,
          origin_code: `${num}-${idx + 1}`
        });
      });
    }

    const existingCodes = (layout.seats || []).map(s => s.code);
    let sNum = 1;
    const getNextStandaloneCode = () => {
      while (existingCodes.includes(`S-${sNum}`)) {
        sNum++;
      }
      const code = `S-${sNum}`;
      existingCodes.push(code);
      return code;
    };

    const newStandaloneSeats = [];
    const newSeatCodes = [];
    for (const origSeat of seatsToCopy) {
      const newCode = getNextStandaloneCode();
      newSeatCodes.push(newCode);
      newStandaloneSeats.push({
        ...origSeat,
        id: Date.now() + Math.floor(Math.random() * 100000),
        code: newCode,
        lx: origSeat.lx + 40,
        ly: origSeat.ly + 40,
        adjacent_codes: [],
        opposite_codes: [],
        origin_code: newCode
      });
    }

    commitLayoutChange({
      ...layout,
      tables: [...(layout.tables || []), ...newTables],
      seats: [...(layout.seats || []), ...newAttachedSeats, ...newStandaloneSeats]
    });

    setSelectedTableIds(newTableIds);
    setSelectedSeatCodes(newSeatCodes);
    setMessage({ type: 'success', text: `已複製 ${newTables.length + newStandaloneSeats.length} 個物件` });
  };

  const handleDeleteSelection = () => {
    const tableIdsToDelete = new Set(selectedTableIds);
    const seatCodesToDelete = new Set(selectedSeatCodes);

    const updatedTables = (layout.tables || []).filter(t => !tableIdsToDelete.has(t.id));
    const updatedSeats = (layout.seats || []).filter(s => {
      if (s.table_id != null && tableIdsToDelete.has(s.table_id)) return false;
      if (seatCodesToDelete.has(s.code)) return false;
      return true;
    });

    commitLayoutChange({
      ...layout,
      tables: updatedTables,
      seats: updatedSeats
    });

    setSelectedTableIds([]);
    setSelectedSeatCodes([]);
    setSelectedTableId(null);
    setSelectedSeatCode(null);
    setMessage({ type: 'success', text: '已刪除選取的物件' });
  };

  // Toggle Adjacent Seat (Bidirectional)
  const handleToggleAdjacent = (targetCode) => {
    if (!selectedSeat) return;
    const currentAdj = selectedSeat.adjacent_codes || [];
    const willInclude = !currentAdj.includes(targetCode);

    const updatedSeats = (layout.seats || []).map(s => {
      if (s.code === selectedSeat.code) {
        const next = willInclude
          ? (currentAdj.includes(targetCode) ? currentAdj : [...currentAdj, targetCode])
          : currentAdj.filter(c => c !== targetCode);
        return { ...s, adjacent_codes: next };
      }
      if (s.code === targetCode) {
        const tAdj = s.adjacent_codes || [];
        const next = willInclude
          ? (tAdj.includes(selectedSeat.code) ? tAdj : [...tAdj, selectedSeat.code])
          : tAdj.filter(c => c !== selectedSeat.code);
        return { ...s, adjacent_codes: next };
      }
      return s;
    });

    commitLayoutChange({ ...layout, seats: updatedSeats });
  };

  // Toggle Opposite Seat (Bidirectional)
  const handleToggleOpposite = (targetCode) => {
    if (!selectedSeat) return;
    const currentOpp = selectedSeat.opposite_codes || [];
    const willInclude = !currentOpp.includes(targetCode);

    const updatedSeats = (layout.seats || []).map(s => {
      if (s.code === selectedSeat.code) {
        const next = willInclude
          ? (currentOpp.includes(targetCode) ? currentOpp : [...currentOpp, targetCode])
          : currentOpp.filter(c => c !== targetCode);
        return { ...s, opposite_codes: next };
      }
      if (s.code === targetCode) {
        const tOpp = s.opposite_codes || [];
        const next = willInclude
          ? (tOpp.includes(selectedSeat.code) ? tOpp : [...tOpp, selectedSeat.code])
          : tOpp.filter(c => c !== selectedSeat.code);
        return { ...s, opposite_codes: next };
      }
      return s;
    });

    commitLayoutChange({ ...layout, seats: updatedSeats });
  };

  // Alignment Tools (Center-Point Based for Tables & Standalone Seats)
  const handleAlign = (type) => {
    const selectedObjects = [
      ...(layout.tables || []).filter(t => selectedTableIds.includes(t.id)).map(t => ({
        type: 'table',
        id: t.id,
        cx: t.cx,
        cy: t.cy,
        w: t.w,
        h: t.h
      })),
      ...(layout.seats || []).filter(s => s.table_id == null && selectedSeatCodes.includes(s.code)).map(s => ({
        type: 'seat',
        id: s.code,
        cx: s.lx,
        cy: s.ly,
        w: 36,
        h: 28
      }))
    ];

    if (selectedObjects.length < 2) return;

    let updatedTables = [...(layout.tables || [])];
    let updatedSeats = [...(layout.seats || [])];

    const applyCenter = (objId, objType, newCx, newCy) => {
      if (objType === 'table') {
        updatedTables = updatedTables.map(t => t.id === objId ? {
          ...t,
          cx: newCx !== undefined ? newCx : t.cx,
          cy: newCy !== undefined ? newCy : t.cy
        } : t);
      } else {
        updatedSeats = updatedSeats.map(s => s.code === objId ? {
          ...s,
          lx: newCx !== undefined ? newCx : s.lx,
          ly: newCy !== undefined ? newCy : s.ly
        } : s);
      }
    };

    if (type === 'left') {
      const minCx = Math.min(...selectedObjects.map(o => o.cx));
      selectedObjects.forEach(o => applyCenter(o.id, o.type, minCx, undefined));
    } else if (type === 'center_h') {
      const avgCx = Math.round(selectedObjects.reduce((sum, o) => sum + o.cx, 0) / selectedObjects.length);
      selectedObjects.forEach(o => applyCenter(o.id, o.type, avgCx, undefined));
    } else if (type === 'right') {
      const maxCx = Math.max(...selectedObjects.map(o => o.cx));
      selectedObjects.forEach(o => applyCenter(o.id, o.type, maxCx, undefined));
    } else if (type === 'top') {
      const minCy = Math.min(...selectedObjects.map(o => o.cy));
      selectedObjects.forEach(o => applyCenter(o.id, o.type, undefined, minCy));
    } else if (type === 'center_v') {
      const avgCy = Math.round(selectedObjects.reduce((sum, o) => sum + o.cy, 0) / selectedObjects.length);
      selectedObjects.forEach(o => applyCenter(o.id, o.type, undefined, avgCy));
    } else if (type === 'bottom') {
      const maxCy = Math.max(...selectedObjects.map(o => o.cy));
      selectedObjects.forEach(o => applyCenter(o.id, o.type, undefined, maxCy));
    } else if (type === 'dist_h') {
      if (selectedObjects.length >= 3) {
        const sorted = [...selectedObjects].sort((a, b) => a.cx - b.cx);
        const minCx = sorted[0].cx;
        const maxCx = sorted[sorted.length - 1].cx;
        const step = (maxCx - minCx) / (sorted.length - 1);
        sorted.forEach((o, i) => {
          const targetCx = Math.round(minCx + step * i);
          applyCenter(o.id, o.type, targetCx, undefined);
        });
      }
    } else if (type === 'dist_v') {
      if (selectedObjects.length >= 3) {
        const sorted = [...selectedObjects].sort((a, b) => a.cy - b.cy);
        const minCy = sorted[0].cy;
        const maxCy = sorted[sorted.length - 1].cy;
        const step = (maxCy - minCy) / (sorted.length - 1);
        sorted.forEach((o, i) => {
          const targetCy = Math.round(minCy + step * i);
          applyCenter(o.id, o.type, undefined, targetCy);
        });
      }
    }

    commitLayoutChange({ ...layout, tables: updatedTables, seats: updatedSeats });
    setMessage({ type: 'success', text: '對齊完成' });
  };

  const canvasW = layout?.canvas_w || 1000;
  const canvasH = layout?.canvas_h || 625;

  return (
    <div className="space-y-4 max-w-7xl mx-auto pb-12 select-none">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-3xl border border-sg-line shadow-xs">
        <div>
          <div className="flex items-center gap-2">
            <span className={`text-[12px] px-2.5 py-0.5 rounded-full font-bold ${layout?.status === 'published' ? 'bg-sg-sage-soft text-sg-sage-ink' : 'bg-sg-honey-soft text-sg-honey'}`}>
              {layout?.status === 'published' ? '已發布生效中' : '編輯草稿中'}
            </span>
            <span className="text-[12px] text-sg-muted">
              1 單位 = 1 公分 · 總座位數 <strong className="font-bold text-sg-ink font-num">{layout?.seats?.filter(s => s.is_active !== false)?.length || 0}</strong> 席
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Undo / Redo */}
          <div className="flex items-center bg-sg-paper rounded-xl p-0.5 border border-sg-line mr-1">
            <button
              type="button"
              data-testid="undo-btn"
              disabled={historyIndex <= 0}
              onClick={handleUndo}
              title="復原 (Ctrl+Z)"
              className="p-1.5 rounded-lg text-sg-ink disabled:opacity-30 hover:bg-white transition"
            >
              <Undo2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              data-testid="redo-btn"
              disabled={historyIndex >= history.length - 1}
              onClick={handleRedo}
              title="重做 (Ctrl+Y)"
              className="p-1.5 rounded-lg text-sg-ink disabled:opacity-30 hover:bg-white transition"
            >
              <Redo2 className="w-4 h-4" />
            </button>
          </div>

          <Button
            variant="secondary"
            size="sm"
            data-testid="save-draft-btn"
            onClick={handleSaveDraft}
            loading={saving}
          >
            <Save className="w-4 h-4 mr-1.5" />
            儲存草稿
          </Button>

          <Button
            variant="primary"
            size="sm"
            onClick={handlePreviewPublish}
            disabled={saving}
          >
            <Send className="w-4 h-4 mr-1.5" />
            發布生效
          </Button>
        </div>
      </div>

      {message && (
        <div className={`p-3.5 rounded-2xl text-[13px] font-bold flex items-center justify-between animate-fade-in ${
          message.type === 'success' ? 'bg-sg-sage-soft text-sg-sage-ink' : 'bg-sg-danger-soft text-sg-danger'
        }`}>
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} className="text-[12px] opacity-75">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Mobile list mode hint banner (Round 17 Item 2) */}
      <div className="md:hidden p-3.5 bg-sg-paper rounded-2xl border border-sg-line text-[12px] text-sg-muted flex items-start gap-2">
        <Smartphone className="w-4 h-4 text-sg-brown flex-shrink-0 mt-0.5" />
        <span>手機可以新增桌子、調整順序和座位標記；要拖曳擺放位置請用平板或電腦。</span>
      </div>

      {/* Mode Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-2 max-w-full">
        <div className="overflow-x-auto max-w-full no-scrollbar">
          <SegmentedTabs
            tabs={[
              { id: 'editor', label: '平面圖畫布', icon: <Layers className="w-4 h-4" /> },
              { id: 'rules', label: '排位規則與試算', icon: <Sliders className="w-4 h-4" /> },
              { id: 'mobile_list', label: '清單模式', icon: <Columns className="w-4 h-4" /> }
            ]}
            activeTab={activeTab}
            onChange={setActiveTab}
          />
        </div>

        {/* Grid Snap & Zoom Controls */}
        <div className="flex items-center gap-2 text-[12px]">
          <button
            type="button"
            data-testid="grid-snap-toggle"
            onClick={() => setGridSnap(g => !g)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-xl border font-bold transition ${
              gridSnap ? 'bg-sg-brown text-white border-sg-brown' : 'bg-white text-sg-muted border-sg-line'
            }`}
          >
            <Grid className="w-3.5 h-3.5" />
            <span>對齊格點 ({layout?.grid_size || 10}cm)</span>
          </button>
        </div>
      </div>

      {/* TAB 1: VISUAL SVG EDITOR */}
      {activeTab === 'editor' && layout && (
        <div className="space-y-3">
          {/* Editor Action Toolbar */}
          <div className="hidden md:flex bg-white p-2.5 rounded-2xl border border-sg-line shadow-xs flex-wrap items-center justify-between gap-2 text-[12px]">
            {/* Presets to Add */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-bold text-sg-muted text-[11px] uppercase mr-1">新增桌型：</span>
              <button
                type="button"
                data-testid="preset-4p"
                onClick={() => handleAddPreset('4p')}
                className="px-2.5 py-1 rounded-xl bg-sg-paper hover:bg-sg-paper/70 border border-sg-line font-bold flex items-center gap-1 text-sg-ink transition active:scale-95"
              >
                <Plus className="w-3 h-3 text-sg-brown" /> 4人對面桌
              </button>
              <button
                type="button"
                data-testid="preset-long"
                onClick={() => handleAddPreset('long')}
                className="px-2.5 py-1 rounded-xl bg-sg-paper hover:bg-sg-paper/70 border border-sg-line font-bold flex items-center gap-1 text-sg-ink transition active:scale-95"
              >
                <Plus className="w-3 h-3 text-sg-brown" /> 長桌
              </button>
              <button
                type="button"
                data-testid="preset-round"
                onClick={() => handleAddPreset('round')}
                className="px-2.5 py-1 rounded-xl bg-sg-paper hover:bg-sg-paper/70 border border-sg-line font-bold flex items-center gap-1 text-sg-ink transition active:scale-95"
              >
                <Plus className="w-3 h-3 text-sg-brown" /> 圓桌
              </button>
              <button
                type="button"
                data-testid="preset-single"
                onClick={() => handleAddPreset('single')}
                className="px-2.5 py-1 rounded-xl bg-sg-paper hover:bg-sg-paper/70 border border-sg-line font-bold flex items-center gap-1 text-sg-ink transition active:scale-95"
              >
                <Plus className="w-3 h-3 text-sg-brown" /> 單人座位
              </button>
              <button
                type="button"
                data-testid="preset-standalone"
                onClick={() => handleAddPreset('standalone')}
                className="px-2.5 py-1 rounded-xl bg-sg-paper hover:bg-sg-paper/70 border border-sg-line font-bold flex items-center gap-1 text-sg-ink transition active:scale-95"
              >
                <Plus className="w-3 h-3 text-sg-brown" /> 單獨座位
              </button>
              <label className="flex items-center gap-1 ml-1 text-[11px] font-bold text-sg-muted">
                <span>放在：</span>
                <select
                  data-testid="new-table-zone-select"
                  value={currentZoneId ?? ''}
                  onChange={(e) => {
                    const zId = Number(e.target.value);
                    currentZoneIdRef.current = zId;
                    setCurrentZoneId(zId);
                  }}
                  className="px-2 py-1 rounded-xl bg-white border border-sg-line font-bold text-sg-ink text-[12px]"
                >
                  {(zoneOrderList.length > 0 ? zoneOrderList : (layout.zones || [])).map(z => (
                    <option key={z.id} value={z.id}>{z.name}</option>
                  ))}
                </select>
              </label>
            </div>

            {/* Architectural & Background Tools */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-bold text-sg-muted text-[11px] uppercase mr-1">環境物件：</span>
              <button
                type="button"
                data-testid="draw-wall-btn"
                onClick={() => {
                  setActiveTool(t => t === 'draw_wall' ? 'select' : 'draw_wall');
                  setDrawingPoints([]);
                }}
                className={`px-2.5 py-1 rounded-xl border font-bold flex items-center gap-1 transition ${
                  activeTool === 'draw_wall' ? 'bg-sg-brown text-white border-sg-brown ring-2 ring-sg-peach' : 'bg-sg-paper text-sg-ink border-sg-line'
                }`}
              >
                <PenTool className="w-3 h-3" />
                <span>畫斜牆 / 牆面</span>
              </button>
              <button
                type="button"
                onClick={() => handleAddEnvRect('door')}
                className="px-2.5 py-1 rounded-xl bg-sg-paper hover:bg-sg-paper/70 border border-sg-line font-bold flex items-center gap-1 text-sg-ink transition"
              >
                <DoorOpen className="w-3 h-3 text-sg-brown" /> 門口
              </button>
              <button
                type="button"
                onClick={() => handleAddEnvRect('counter')}
                className="px-2.5 py-1 rounded-xl bg-sg-paper hover:bg-sg-paper/70 border border-sg-line font-bold flex items-center gap-1 text-sg-ink transition"
              >
                <Store className="w-3 h-3 text-sg-brown" /> 櫃檯
              </button>
              <button
                type="button"
                onClick={() => handleAddEnvRect('pillar')}
                className="px-2.5 py-1 rounded-xl bg-sg-paper hover:bg-sg-paper/70 border border-sg-line font-bold flex items-center gap-1 text-sg-ink transition"
              >
                <Columns className="w-3 h-3 text-sg-brown" /> 柱子
              </button>

              <div className="h-4 w-px bg-sg-line mx-1" />

              <input
                type="file"
                ref={fileInputRef}
                accept="image/*"
                onChange={handleBgImageUpload}
                className="hidden"
              />
              <button
                type="button"
                data-testid="upload-bg-btn"
                onClick={() => fileInputRef.current?.click()}
                className="px-2.5 py-1 rounded-xl bg-sg-paper hover:bg-sg-paper/70 border border-sg-line font-bold flex items-center gap-1 text-sg-ink transition"
              >
                <ImageIcon className="w-3 h-3 text-sg-brown" />
                <span>上傳底圖</span>
              </button>
            </div>
          </div>

          {/* In-progress drawing hint bar */}
          {(activeTool === 'draw_wall' || activeTool === 'draw_window') && (
            <div className="bg-sg-peach/20 border border-sg-peach p-2.5 rounded-xl flex items-center justify-between text-[12px] font-bold text-sg-ink animate-fade-in">
              <div className="flex items-center gap-2">
                <PenTool className="w-4 h-4 text-sg-brown" />
                <span>點擊畫布以放置頂點（支援斜線），目前已點 {drawingPoints.length} 個點</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="finish-wall-btn"
                  onClick={handleFinishDrawing}
                  disabled={drawingPoints.length < 2}
                  className="px-3 py-1 bg-sg-brown text-white rounded-lg disabled:opacity-40"
                >
                  完成繪製
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDrawingPoints([]);
                    setActiveTool('select');
                  }}
                  className="px-2 py-1 text-sg-muted hover:text-sg-ink"
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {/* Multi-selection Alignment Bar */}
          {(selectedTableIds.length + selectedSeatCodes.length >= 2) && (
            <div className="bg-white p-2.5 rounded-xl border border-sg-brown/40 shadow-xs flex items-center justify-between text-[12px] animate-fade-in">
              <span className="font-bold text-sg-ink">已選取 {selectedTableIds.length + selectedSeatCodes.length} 個物件</span>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => handleAlign('left')} title="靠左對齊" className="p-1.5 hover:bg-sg-paper rounded"><AlignLeft className="w-4 h-4" /></button>
                <button type="button" onClick={() => handleAlign('center_h')} title="水平置中" className="p-1.5 hover:bg-sg-paper rounded"><AlignCenter className="w-4 h-4" /></button>
                <button type="button" onClick={() => handleAlign('right')} title="靠右對齊" className="p-1.5 hover:bg-sg-paper rounded"><AlignRight className="w-4 h-4" /></button>
                <div className="h-3 w-px bg-sg-line mx-1" />
                <button type="button" onClick={() => handleAlign('top')} title="靠頂對齊" className="p-1.5 hover:bg-sg-paper rounded rotate-90"><AlignLeft className="w-4 h-4" /></button>
                <button type="button" onClick={() => handleAlign('center_v')} title="垂直置中" className="p-1.5 hover:bg-sg-paper rounded"><AlignVerticalJustifyCenter className="w-4 h-4" /></button>
                <button type="button" onClick={() => handleAlign('bottom')} title="靠底對齊" className="p-1.5 hover:bg-sg-paper rounded rotate-90"><AlignRight className="w-4 h-4" /></button>
                <div className="h-3 w-px bg-sg-line mx-1" />
                <button type="button" disabled={selectedTableIds.length + selectedSeatCodes.length < 3} onClick={() => handleAlign('dist_h')} title="水平平均分布" className="p-1.5 hover:bg-sg-paper rounded disabled:opacity-40"><AlignHorizontalJustifyCenter className="w-4 h-4" /></button>
                <button type="button" disabled={selectedTableIds.length + selectedSeatCodes.length < 3} onClick={() => handleAlign('dist_v')} title="垂直平均分布" className="p-1.5 hover:bg-sg-paper rounded disabled:opacity-40"><AlignVerticalJustifyCenter className="w-4 h-4" /></button>
              </div>
            </div>
          )}

          {/* Main Workspace: Left SVG Canvas, Right Inspector */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            {/* SVG Canvas Area */}
            <div className="lg:col-span-8 bg-white rounded-3xl border border-sg-line p-3 shadow-xs overflow-hidden flex flex-col items-center">
              <div className="w-full flex justify-between items-center px-2 pb-2 text-[11px] text-sg-muted border-b border-sg-line">
                <span>點選桌子以旋轉或調整尺寸 · 拖曳座位可移出桌邊</span>
                <span>{canvasW} × {canvasH} cm</span>
              </div>

              <div className="w-full overflow-auto flex justify-center py-2" style={{ maxHeight: '72vh' }}>
                <svg
                  ref={svgRef}
                  data-testid="seat-layout-svg"
                  viewBox={`0 0 ${canvasW} ${canvasH}`}
                  className="bg-[#FAF7F2] border border-sg-line rounded-2xl shadow-inner select-none cursor-crosshair"
                  style={{
                    width: '100%',
                    maxWidth: canvasW,
                    height: 'auto',
                    aspectRatio: `${canvasW} / ${canvasH}`
                  }}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                >
                  <defs>
                    {/* Grid pattern */}
                    {gridSnap && (
                      <pattern id="grid-pattern" width={layout?.grid_size || 10} height={layout?.grid_size || 10} patternUnits="userSpaceOnUse">
                        <circle cx="1" cy="1" r="1" fill="#C8BEB2" opacity="0.4" />
                      </pattern>
                    )}
                  </defs>

                  <rect id="canvas-bg" width={canvasW} height={canvasH} fill="#FAF7F2" />
                  {gridSnap && <rect width={canvasW} height={canvasH} fill="url(#grid-pattern)" pointerEvents="none" />}

                  {/* Background image if present */}
                  {layout.background_image && (
                    <image
                      href={layout.background_image}
                      x={layout.background_rect?.x || 0}
                      y={layout.background_rect?.y || 0}
                      width={layout.background_rect?.w || canvasW}
                      height={layout.background_rect?.h || canvasH}
                      opacity={(layout.background_opacity ?? 40) / 100}
                      preserveAspectRatio="none"
                      pointerEvents="none"
                    />
                  )}

                  {/* Zones polygons */}
                  {(layout.zones || []).map((zone) => {
                    if (!zone.polygon || zone.polygon.length < 3) return null;
                    const pts = zone.polygon.map(p => p.join(',')).join(' ');
                    return (
                      <g key={zone.id}>
                        <polygon
                          points={pts}
                          fill="#DDCDBF"
                          fillOpacity="0.25"
                          stroke="#A78B71"
                          strokeWidth="1.5"
                          strokeDasharray="4,4"
                          pointerEvents="none"
                        />
                        <text
                          x={zone.polygon[0][0] + 8}
                          y={zone.polygon[0][1] + 16}
                          fill="#796E65"
                          fontSize="13"
                          fontWeight="bold"
                        >
                          {zone.name}
                        </text>
                      </g>
                    );
                  })}

                  {/* Architectural elements (walls, windows, doors, counters, pillars) */}
                  {(layout.elements_json || []).map((el) => {
                    const isSelected = el.id === selectedElementId;
                    if (el.type === 'wall' && el.points?.length > 1) {
                      return (
                        <polyline
                          key={el.id}
                          points={el.points.map(p => p.join(',')).join(' ')}
                          stroke={isSelected ? '#F87171' : '#796E65'}
                          strokeWidth={el.thickness || 4}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                          cursor="pointer"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedElementId(el.id);
                            setSelectedTableId(null);
                            setSelectedSeatCode(null);
                          }}
                        />
                      );
                    }
                    if (el.type === 'window' && el.points?.length > 1) {
                      return (
                        <polyline
                          key={el.id}
                          points={el.points.map(p => p.join(',')).join(' ')}
                          stroke={isSelected ? '#F87171' : '#78B5C5'}
                          strokeWidth={el.thickness || 3}
                          strokeDasharray="6,3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                          cursor="pointer"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedElementId(el.id);
                            setSelectedTableId(null);
                            setSelectedSeatCode(null);
                          }}
                        />
                      );
                    }
                    if (el.type === 'door' || el.type === 'counter' || el.type === 'pillar') {
                      return (
                        <g
                          key={el.id}
                          transform={el.rotation ? `rotate(${el.rotation} ${el.x + el.w / 2} ${el.y + el.h / 2})` : undefined}
                          cursor="move"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            setSelectedElementId(el.id);
                            setSelectedTableId(null);
                            setSelectedSeatCode(null);
                            const coords = getCanvasCoords(e);
                            setDragInfo({
                              mode: 'move_element',
                              elementId: el.id,
                              startX: coords.x,
                              startY: coords.y,
                              initX: el.x,
                              initY: el.y
                            });
                          }}
                        >
                          <rect
                            x={el.x}
                            y={el.y}
                            width={el.w}
                            height={el.h}
                            fill={el.type === 'pillar' ? '#796E65' : '#E5DDD0'}
                            stroke={isSelected ? '#D97706' : '#C8BEB2'}
                            strokeWidth={isSelected ? 2.5 : 1.5}
                            rx="4"
                          />
                          <text
                            x={el.x + el.w / 2}
                            y={el.y + el.h / 2 + 4}
                            textAnchor="middle"
                            fontSize="11"
                            fontWeight="bold"
                            fill="#5C554E"
                            pointerEvents="none"
                          >
                            {el.label}
                          </text>
                        </g>
                      );
                    }
                    return null;
                  })}

                  {/* In-progress drawing preview line */}
                  {drawingPoints.length > 0 && (
                    <g pointerEvents="none">
                      <polyline
                        points={drawingPoints.map(p => p.join(',')).join(' ')}
                        stroke="#B45309"
                        strokeWidth="3"
                        strokeDasharray="4,4"
                        fill="none"
                      />
                      {cursorPos && (
                        <line
                          x1={drawingPoints[drawingPoints.length - 1][0]}
                          y1={drawingPoints[drawingPoints.length - 1][1]}
                          x2={cursorPos.x}
                          y2={cursorPos.y}
                          stroke="#B45309"
                          strokeWidth="2"
                          strokeDasharray="3,3"
                        />
                      )}
                    </g>
                  )}

                  {/* Tables */}
                  {(layout.tables || []).map((t) => {
                    const isSelected = selectedTableId === t.id || selectedTableIds.includes(t.id);
                    const isRound = t.shape === 'round';

                    return (
                      <g
                        key={t.id}
                        data-testid={`table-node-${t.label}`}
                        data-cx={t.cx}
                        data-cy={t.cy}
                        transform={`rotate(${t.rotation || 0} ${t.cx} ${t.cy})`}
                        cursor="move"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          const coords = getCanvasCoords(e);
                          if (e.shiftKey) {
                            setSelectedTableIds(prev => {
                              const next = prev.includes(t.id) ? prev.filter(id => id !== t.id) : [...prev, t.id];
                              if (next.length === 1 && selectedSeatCodes.length === 0) {
                                setSelectedTableId(next[0]);
                              } else {
                                setSelectedTableId(null);
                              }
                              return next;
                            });
                          } else {
                            if (selectedTableIds.includes(t.id) && (selectedTableIds.length + selectedSeatCodes.length >= 2)) {
                              const initTables = (layout.tables || []).filter(tbl => selectedTableIds.includes(tbl.id)).map(tbl => ({ id: tbl.id, cx: tbl.cx, cy: tbl.cy }));
                              const initSeats = (layout.seats || []).filter(st => selectedSeatCodes.includes(st.code)).map(st => ({ code: st.code, lx: st.lx, ly: st.ly }));
                              setDragInfo({
                                mode: 'move_selection',
                                tableId: t.id,
                                hasMoved: false,
                                startX: coords.x,
                                startY: coords.y,
                                initTables,
                                initSeats
                              });
                              return;
                            } else {
                              setSelectedTableId(t.id);
                              setSelectedTableIds([t.id]);
                              setSelectedSeatCode(null);
                              setSelectedSeatCodes([]);
                              setSelectedElementId(null);
                            }
                          }
                          setDragInfo({
                            mode: 'move_table',
                            tableId: t.id,
                            startX: coords.x,
                            startY: coords.y,
                            initCx: t.cx,
                            initCy: t.cy
                          });
                        }}
                      >
                        {/* Selection outline */}
                        {isSelected && (
                          <rect
                            x={t.cx - t.w / 2 - 6}
                            y={t.cy - t.h / 2 - 6}
                            width={t.w + 12}
                            height={t.h + 12}
                            rx={isRound ? (t.w + 12) / 2 : 14}
                            fill="none"
                            stroke="#B45309"
                            strokeWidth="2"
                            strokeDasharray="4,4"
                            pointerEvents="none"
                          />
                        )}

                        {/* Table body */}
                        {isRound ? (
                          <circle
                            cx={t.cx}
                            cy={t.cy}
                            r={t.w / 2}
                            fill="#EADDCF"
                            stroke={isSelected ? '#78350F' : '#C8BEB2'}
                            strokeWidth={isSelected ? 3 : 1.5}
                          />
                        ) : (
                          <rect
                            x={t.cx - t.w / 2}
                            y={t.cy - t.h / 2}
                            width={t.w}
                            height={t.h}
                            rx="10"
                            fill="#EADDCF"
                            stroke={isSelected ? '#78350F' : '#C8BEB2'}
                            strokeWidth={isSelected ? 3 : 1.5}
                          />
                        )}

                        {/* Table label */}
                        <text
                          x={t.cx}
                          y={t.cy + 4}
                          textAnchor="middle"
                          fontSize="13"
                          fontWeight="bold"
                          fill="#5C554E"
                          pointerEvents="none"
                        >
                          {t.label}
                        </text>

                        {/* Selected Table Handles: Rotate handle and Resize handles */}
                        {selectedTableId === t.id && (
                          <g>
                            {/* Rotation Handle: circle above top edge */}
                            <line
                              x1={t.cx}
                              y1={t.cy - t.h / 2}
                              x2={t.cx}
                              y2={t.cy - t.h / 2 - 25}
                              stroke="#78350F"
                              strokeWidth="2"
                              strokeDasharray="2,2"
                            />
                            <circle
                              data-testid="table-rotate-handle"
                              cx={t.cx}
                              cy={t.cy - t.h / 2 - 25}
                              r="7"
                              fill="#B45309"
                              stroke="#FFF"
                              strokeWidth="2"
                              cursor="grab"
                              onPointerDown={(e) => {
                                e.stopPropagation();
                                setDragInfo({
                                  mode: 'rotate_table',
                                  tableId: t.id,
                                  cx: t.cx,
                                  cy: t.cy
                                });
                              }}
                            />

                            {/* Resize handles */}
                            {!isRound && (
                              <>
                                {/* Right width handle */}
                                <rect
                                  x={t.cx + t.w / 2 - 4}
                                  y={t.cy - 6}
                                  width="8"
                                  height="12"
                                  rx="2"
                                  fill="#FFF"
                                  stroke="#78350F"
                                  strokeWidth="1.5"
                                  cursor="ew-resize"
                                  onPointerDown={(e) => {
                                    e.stopPropagation();
                                    const coords = getCanvasCoords(e);
                                    setDragInfo({
                                      mode: 'resize_table',
                                      handle: 'e',
                                      tableId: t.id,
                                      startX: coords.x,
                                      startY: coords.y,
                                      initW: t.w,
                                      initH: t.h
                                    });
                                  }}
                                />
                                {/* Bottom height handle */}
                                <rect
                                  x={t.cx - 6}
                                  y={t.cy + t.h / 2 - 4}
                                  width="12"
                                  height="8"
                                  rx="2"
                                  fill="#FFF"
                                  stroke="#78350F"
                                  strokeWidth="1.5"
                                  cursor="ns-resize"
                                  onPointerDown={(e) => {
                                    e.stopPropagation();
                                    const coords = getCanvasCoords(e);
                                    setDragInfo({
                                      mode: 'resize_table',
                                      handle: 's',
                                      tableId: t.id,
                                      startX: coords.x,
                                      startY: coords.y,
                                      initW: t.w,
                                      initH: t.h
                                    });
                                  }}
                                />
                              </>
                            )}
                          </g>
                        )}
                      </g>
                    );
                  })}

                  {/* Seats */}
                  {(layout.seats || []).map((seat) => {
                    const table = (layout.tables || []).find(t => t.id === seat.table_id);
                    const tRot = ((table?.rotation || 0) * Math.PI) / 180;
                    const lx = seat.lx || 0;
                    const ly = seat.ly || 0;
                    const rotLx = table ? (lx * Math.cos(tRot) - ly * Math.sin(tRot)) : lx;
                    const rotLy = table ? (lx * Math.sin(tRot) + ly * Math.cos(tRot)) : ly;

                    const cx = (table?.cx || 0) + rotLx;
                    const cy = (table?.cy || 0) + rotLy;

                    const isSelected = selectedSeatCode === seat.code || selectedSeatCodes.includes(seat.code);
                    const isInactive = seat.is_active === false;

                    return (
                      <g
                        key={seat.code}
                        data-testid={`seat-node-${seat.code}`}
                        data-cx={cx}
                        data-cy={cy}
                        transform={`rotate(${table?.rotation || 0} ${cx} ${cy})`}
                        cursor="grab"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedSeatCode(seat.code);
                          setSelectedSeatCodes([seat.code]);
                          setSelectedTableId(seat.table_id || null);
                          setSelectedTableIds([]);
                          setSelectedElementId(null);
                        }}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          const coords = getCanvasCoords(e);
                          if (e.shiftKey) {
                            setSelectedSeatCodes(prev => {
                              const next = prev.includes(seat.code) ? prev.filter(c => c !== seat.code) : [...prev, seat.code];
                              if (next.length === 1 && selectedTableIds.length === 0) {
                                setSelectedSeatCode(next[0]);
                              } else {
                                setSelectedSeatCode(null);
                              }
                              return next;
                            });
                          } else {
                            if (selectedSeatCodes.includes(seat.code) && (selectedTableIds.length + selectedSeatCodes.length >= 2)) {
                              const initTables = (layout.tables || []).filter(tbl => selectedTableIds.includes(tbl.id)).map(tbl => ({ id: tbl.id, cx: tbl.cx, cy: tbl.cy }));
                              const initSeats = (layout.seats || []).filter(st => selectedSeatCodes.includes(st.code)).map(st => ({ code: st.code, lx: st.lx, ly: st.ly }));
                              setDragInfo({
                                mode: 'move_selection',
                                seatCode: seat.code,
                                hasMoved: false,
                                startX: coords.x,
                                startY: coords.y,
                                initTables,
                                initSeats
                              });
                              return;
                            } else {
                              setSelectedSeatCode(seat.code);
                              setSelectedSeatCodes([seat.code]);
                              setSelectedTableId(seat.table_id || null);
                              setSelectedTableIds([]);
                              setSelectedElementId(null);
                            }
                          }

                          if (!table) {
                            setDragInfo({
                              mode: 'move_seat',
                              seatCode: seat.code,
                              table: null,
                              startX: coords.x,
                              startY: coords.y,
                              initLx: seat.lx,
                              initLy: seat.ly
                            });
                          } else {
                            setDragInfo({
                              mode: 'move_seat',
                              seatCode: seat.code,
                              table,
                              startX: coords.x,
                              startY: coords.y,
                              initLx: seat.lx,
                              initLy: seat.ly
                            });
                          }
                        }}
                      >
                        {isSelected && (
                          <rect
                            x={cx - 22}
                            y={cy - 18}
                            width="44"
                            height="36"
                            rx="12"
                            fill="none"
                            stroke="#B45309"
                            strokeWidth="2"
                            strokeDasharray="4,4"
                            pointerEvents="none"
                          />
                        )}
                        <rect
                          x={cx - 18}
                          y={cy - 14}
                          width="36"
                          height="28"
                          rx="8"
                          fill={isInactive ? '#E5E7EB' : isSelected ? '#FDE68A' : '#FFF'}
                          stroke={isSelected ? '#B45309' : '#C8BEB2'}
                          strokeWidth={isSelected ? 2.5 : 1.5}
                          filter="drop-shadow(0px 1px 2px rgba(0,0,0,0.06))"
                        />
                        <text
                          x={cx}
                          y={cy + 4}
                          textAnchor="middle"
                          fontSize="10"
                          fontWeight="bold"
                          fill={isInactive ? '#9CA3AF' : '#1F2937'}
                          pointerEvents="none"
                        >
                          {seat.code}
                        </text>
                      </g>
                    );
                  })}

                  {/* Marquee Selection Rectangle */}
                  {marquee && (
                    <rect
                      x={Math.min(marquee.startX, marquee.currentX)}
                      y={Math.min(marquee.startY, marquee.currentY)}
                      width={Math.abs(marquee.currentX - marquee.startX)}
                      height={Math.abs(marquee.currentY - marquee.startY)}
                      fill="#B45309"
                      fillOpacity="0.15"
                      stroke="#B45309"
                      strokeWidth="1.5"
                      strokeDasharray="4,4"
                      pointerEvents="none"
                    />
                  )}
                </svg>
              </div>
            </div>

            {/* Right Inspector Sidebar */}
            <div className="lg:col-span-4 bg-white rounded-3xl border border-sg-line p-4 space-y-4 shadow-xs">
              {/* Properties for Multi-selection */}
              {(selectedTableIds.length + selectedSeatCodes.length >= 2) && (
                <div className="space-y-4" data-testid="multi-selection-inspector">
                  <div className="flex items-center justify-between pb-2 border-b border-sg-line">
                    <h3 className="text-[15px] font-bold text-sg-ink">多選設定</h3>
                    <span className="text-[12px] bg-sg-peach/30 text-sg-brown px-2 py-0.5 rounded-full font-bold font-num">
                      {selectedTableIds.length + selectedSeatCodes.length} 個物件
                    </span>
                  </div>

                  <div className="text-[12px] text-sg-muted">
                    已選取 {selectedTableIds.length} 張桌子、{selectedSeatCodes.length} 個單獨座位
                  </div>

                  {/* Batch Actions */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      data-testid="batch-copy-btn"
                      onClick={handleCopySelection}
                      className="flex-1 py-1.5 px-3 rounded-xl border border-sg-line bg-sg-paper hover:bg-sg-paper/70 font-bold text-[13px] text-sg-ink flex items-center justify-center gap-1.5 transition"
                    >
                      <Copy className="w-4 h-4 text-sg-brown" /> 複製全部
                    </button>
                    <button
                      type="button"
                      data-testid="batch-delete-btn"
                      onClick={handleDeleteSelection}
                      className="flex-1 py-1.5 px-3 rounded-xl border border-sg-danger/30 bg-sg-danger-soft hover:bg-sg-danger-soft/70 font-bold text-[13px] text-sg-danger flex items-center justify-center gap-1.5 transition"
                    >
                      <Trash2 className="w-4 h-4" /> 刪除全部
                    </button>
                  </div>

                  {/* Alignments (Based on center point) */}
                  <div className="space-y-2 pt-2 border-t border-sg-line">
                    <label className="block text-sg-muted font-medium text-[12px]">
                      中心點對齊與分布
                    </label>
                    <div className="grid grid-cols-2 gap-2 text-[12px]">
                      <button
                        type="button"
                        data-testid="align-left"
                        onClick={() => handleAlign('left')}
                        className="py-1.5 px-2.5 rounded-xl border border-sg-line bg-white hover:bg-sg-paper font-bold flex items-center justify-center gap-1.5 transition"
                      >
                        <AlignLeft className="w-3.5 h-3.5" /> 靠左
                      </button>
                      <button
                        type="button"
                        data-testid="align-center-h"
                        onClick={() => handleAlign('center_h')}
                        className="py-1.5 px-2.5 rounded-xl border border-sg-line bg-white hover:bg-sg-paper font-bold flex items-center justify-center gap-1.5 transition"
                      >
                        <AlignCenter className="w-3.5 h-3.5" /> 水平置中
                      </button>
                      <button
                        type="button"
                        data-testid="align-right"
                        onClick={() => handleAlign('right')}
                        className="py-1.5 px-2.5 rounded-xl border border-sg-line bg-white hover:bg-sg-paper font-bold flex items-center justify-center gap-1.5 transition"
                      >
                        <AlignRight className="w-3.5 h-3.5" /> 靠右
                      </button>
                      <button
                        type="button"
                        data-testid="align-top"
                        onClick={() => handleAlign('top')}
                        className="py-1.5 px-2.5 rounded-xl border border-sg-line bg-white hover:bg-sg-paper font-bold flex items-center justify-center gap-1.5 transition"
                      >
                        <AlignLeft className="w-3.5 h-3.5 rotate-90" /> 靠上
                      </button>
                      <button
                        type="button"
                        data-testid="align-center-v"
                        onClick={() => handleAlign('center_v')}
                        className="py-1.5 px-2.5 rounded-xl border border-sg-line bg-white hover:bg-sg-paper font-bold flex items-center justify-center gap-1.5 transition"
                      >
                        <AlignVerticalJustifyCenter className="w-3.5 h-3.5" /> 垂直置中
                      </button>
                      <button
                        type="button"
                        data-testid="align-bottom"
                        onClick={() => handleAlign('bottom')}
                        className="py-1.5 px-2.5 rounded-xl border border-sg-line bg-white hover:bg-sg-paper font-bold flex items-center justify-center gap-1.5 transition"
                      >
                        <AlignRight className="w-3.5 h-3.5 rotate-90" /> 靠下
                      </button>
                      <button
                        type="button"
                        data-testid="dist-h"
                        disabled={selectedTableIds.length + selectedSeatCodes.length < 3}
                        onClick={() => handleAlign('dist_h')}
                        className="col-span-2 py-1.5 px-2.5 rounded-xl border border-sg-line bg-white hover:bg-sg-paper font-bold flex items-center justify-center gap-1.5 transition disabled:opacity-40"
                      >
                        <AlignHorizontalJustifyCenter className="w-3.5 h-3.5" /> 水平平均分布
                      </button>
                      <button
                        type="button"
                        data-testid="dist-v"
                        disabled={selectedTableIds.length + selectedSeatCodes.length < 3}
                        onClick={() => handleAlign('dist_v')}
                        className="col-span-2 py-1.5 px-2.5 rounded-xl border border-sg-line bg-white hover:bg-sg-paper font-bold flex items-center justify-center gap-1.5 transition disabled:opacity-40"
                      >
                        <AlignVerticalJustifyCenter className="w-3.5 h-3.5" /> 垂直平均分布
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Properties for Selected Table */}
              {selectedTable && (selectedTableIds.length + selectedSeatCodes.length < 2) && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between pb-2 border-b border-sg-line">
                    <h3 className="text-[15px] font-bold text-sg-ink">桌子設定 ({selectedTable.label})</h3>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        data-testid="copy-table-btn"
                        onClick={() => handleCopyTable(selectedTable.id)}
                        title="複製這張桌"
                        className="p-1.5 hover:bg-sg-paper rounded text-sg-muted hover:text-sg-ink"
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        data-testid="delete-btn"
                        onClick={() => handleDeleteTable(selectedTable.id)}
                        title="刪除這張桌"
                        className="p-1.5 hover:bg-sg-danger-soft rounded text-sg-danger"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-[13px]">
                    <div>
                      <label className="block text-sg-muted mb-1 font-medium">桌號名稱</label>
                      <input
                        type="text"
                        data-testid="table-label-input"
                        value={selectedTable.label}
                        onChange={(e) => {
                          const val = e.target.value;
                          setLayout(prev => ({
                            ...prev,
                            tables: prev.tables.map(t => t.id === selectedTable.id ? { ...t, label: val } : t)
                          }));
                        }}
                        onBlur={() => commitLayoutChange(layout)}
                        className="w-full px-3 py-1.5 rounded-xl border border-sg-line font-bold"
                      />
                    </div>

                    <div>
                      <label className="block text-sg-muted mb-1 font-medium">角度 (°)</label>
                      <input
                        type="number"
                        data-testid="table-rotation-input"
                        value={selectedTable.rotation || 0}
                        onChange={(e) => {
                          const rot = Number(e.target.value) || 0;
                          setLayout(prev => ({
                            ...prev,
                            tables: prev.tables.map(t => t.id === selectedTable.id ? { ...t, rotation: rot } : t)
                          }));
                        }}
                        onBlur={() => commitLayoutChange(layout)}
                        className="w-full px-3 py-1.5 rounded-xl border border-sg-line font-bold"
                      />
                    </div>

                    <div>
                      <label className="block text-sg-muted mb-1 font-medium">寬度 (cm)</label>
                      <input
                        type="number"
                        data-testid="table-w-input"
                        value={selectedTable.w || 60}
                        onChange={(e) => {
                          const val = Math.max(20, Number(e.target.value) || 20);
                          setLayout(prev => ({
                            ...prev,
                            tables: prev.tables.map(t => t.id === selectedTable.id ? { ...t, w: val } : t)
                          }));
                        }}
                        onBlur={() => commitLayoutChange(layout)}
                        className="w-full px-3 py-1.5 rounded-xl border border-sg-line font-bold"
                      />
                    </div>

                    <div>
                      <label className="block text-sg-muted mb-1 font-medium">長度 (cm)</label>
                      <input
                        type="number"
                        data-testid="table-h-input"
                        value={selectedTable.h || 140}
                        onChange={(e) => {
                          const val = Math.max(20, Number(e.target.value) || 20);
                          setLayout(prev => ({
                            ...prev,
                            tables: prev.tables.map(t => t.id === selectedTable.id ? { ...t, h: val } : t)
                          }));
                        }}
                        onBlur={() => commitLayoutChange(layout)}
                        className="w-full px-3 py-1.5 rounded-xl border border-sg-line font-bold"
                      />
                    </div>
                  </div>

                  <div className="text-[13px] space-y-2">
                    <div>
                      <label className="block text-sg-muted mb-1 font-medium">所屬區域</label>
                      <select
                        data-testid="table-zone-select"
                        value={selectedTable.zone_id || ''}
                        onChange={(e) => {
                          const zId = Number(e.target.value);
                          commitLayoutChange({
                            ...layout,
                            tables: layout.tables.map(t => t.id === selectedTable.id ? { ...t, zone_id: zId } : t),
                            seats: layout.seats.map(s => s.table_id === selectedTable.id ? { ...s, zone_id: zId } : s)
                          });
                        }}
                        className="w-full px-3 py-1.5 rounded-xl border border-sg-line font-bold bg-white"
                      >
                        {(zoneOrderList.length > 0 ? zoneOrderList : (layout.zones || [])).map(z => (
                          <option key={z.id} value={z.id}>{z.name}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-sg-muted mb-1 font-medium">座位排法</label>
                      <select
                        value={selectedTable.arrangement || 'two_sides'}
                        onChange={(e) => {
                          const arr = e.target.value;
                          commitLayoutChange({
                            ...layout,
                            tables: layout.tables.map(t => t.id === selectedTable.id ? { ...t, arrangement: arr } : t)
                          });
                        }}
                        className="w-full px-3 py-1.5 rounded-xl border border-sg-line font-bold bg-white"
                      >
                        <option value="two_sides">雙側對坐 (two_sides)</option>
                        <option value="one_side">單側排座 (one_side)</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* Properties for Selected Seat */}
              {selectedSeat && (selectedTableIds.length + selectedSeatCodes.length < 2) && (
                <div className="space-y-4 pt-2 border-t border-sg-line">
                  <div className="flex items-center justify-between pb-2 border-b border-sg-line">
                    <h3 className="text-[15px] font-bold text-sg-ink">座位設定 ({selectedSeat.code})</h3>
                    <div className="flex items-center gap-2">
                      {selectedSeat.table_id ? (
                        <button
                          type="button"
                          onClick={() => {
                            // Detach seat from table
                            commitLayoutChange({
                              ...layout,
                              seats: layout.seats.map(s => s.code === selectedSeat.code ? { ...s, table_id: null } : s)
                            });
                            setMessage({ type: 'success', text: '已移出這張桌' });
                          }}
                          className="text-[11px] font-bold text-sg-brown hover:underline"
                        >
                          移出這張桌
                        </button>
                      ) : (
                        <button
                          type="button"
                          data-testid="delete-seat-btn"
                          onClick={() => handleDeleteSeat(selectedSeat.code)}
                          title="刪除單獨座位"
                          className="p-1 hover:bg-sg-danger-soft rounded text-sg-danger"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="space-y-3 text-[13px]">
                    <div>
                      <label className="block text-sg-muted mb-1 font-medium">座位代號</label>
                      <input
                        type="text"
                        data-testid="seat-code-input"
                        value={selectedSeat.code}
                        onChange={(e) => {
                          const newCode = e.target.value.trim().toUpperCase();
                          const oldOrigin = selectedSeat.origin_code || selectedSeat.code;
                          setLayout(prev => ({
                            ...prev,
                            seats: prev.seats.map(s => s.code === selectedSeat.code ? { ...s, code: newCode, origin_code: oldOrigin } : s)
                          }));
                          setSelectedSeatCode(newCode);
                        }}
                        onBlur={() => commitLayoutChange(layout)}
                        className="w-full px-3 py-1.5 rounded-xl border border-sg-line font-bold"
                      />
                    </div>

                    <div>
                      <label className="block text-sg-muted mb-1 font-medium">排位優先度</label>
                      <select
                        data-testid="seat-priority-select"
                        value={selectedSeat.priority || 'normal'}
                        onChange={(e) => {
                          const pri = e.target.value;
                          commitLayoutChange({
                            ...layout,
                            seats: layout.seats.map(s => s.code === selectedSeat.code ? { ...s, priority: pri } : s)
                          });
                        }}
                        className="w-full px-3 py-1.5 rounded-xl border border-sg-line font-bold bg-white"
                      >
                        <option value="normal">一般優先</option>
                        <option value="second">第二順位</option>
                        <option value="last">最後排（冷氣出風口/邊角）</option>
                        <option value="manual_only">不自動排（現場手動）</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-sg-muted mb-1 font-medium">側邊模式</label>
                      <select
                        value={selectedSeat.side_mode || 'auto'}
                        onChange={(e) => {
                          const mode = e.target.value;
                          commitLayoutChange({
                            ...layout,
                            seats: layout.seats.map(s => s.code === selectedSeat.code ? { ...s, side_mode: mode } : s)
                          });
                        }}
                        className="w-full px-3 py-1.5 rounded-xl border border-sg-line font-bold bg-white"
                      >
                        <option value="auto">自動判定側邊</option>
                        <option value="manual">手動指定 (L/R)</option>
                      </select>
                    </div>

                    {/* Adjacent Seats Setting (相鄰座位 / 另外指定相鄰) */}
                    <div>
                      <label className="block text-sg-muted mb-1 font-medium text-[12px]">
                        {selectedSeat.table_id == null ? '相鄰座位' : '另外指定相鄰'}
                      </label>
                      <div className="flex flex-wrap gap-1 mb-1.5">
                        {(selectedSeat.adjacent_codes || []).map(code => (
                          <span
                            key={code}
                            data-testid={`adjacent-chip-${code}`}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-sg-peach/30 text-sg-brown text-[11px] font-bold"
                          >
                            {code}
                            <button
                              type="button"
                              onClick={() => handleToggleAdjacent(code)}
                              className="hover:text-sg-danger"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                        {(!selectedSeat.adjacent_codes || selectedSeat.adjacent_codes.length === 0) && (
                          <span className="text-[11px] text-sg-muted italic">無相鄰設定</span>
                        )}
                      </div>
                      <select
                        data-testid="adjacent-seat-select"
                        value=""
                        onChange={(e) => {
                          if (e.target.value) {
                            handleToggleAdjacent(e.target.value);
                            e.target.value = '';
                          }
                        }}
                        className="w-full px-2.5 py-1 rounded-xl border border-sg-line text-[12px] font-bold bg-white"
                      >
                        <option value="">+ 新增相鄰座位...</option>
                        {(layout.seats || [])
                          .filter(s => s.code !== selectedSeat.code && !(selectedSeat.adjacent_codes || []).includes(s.code))
                          .map(s => (
                            <option key={s.code} value={s.code}>
                              {s.code} {s.table_id == null ? '(單獨)' : ''}
                            </option>
                          ))}
                      </select>
                    </div>

                    {/* Opposite Seats Setting (另外指定對面) */}
                    <div>
                      <label className="block text-sg-muted mb-1 font-medium text-[12px]">
                        另外指定對面
                      </label>
                      <div className="flex flex-wrap gap-1 mb-1.5">
                        {(selectedSeat.opposite_codes || []).map(code => (
                          <span
                            key={code}
                            data-testid={`opposite-chip-${code}`}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-sg-paper border border-sg-line text-sg-ink text-[11px] font-bold"
                          >
                            {code}
                            <button
                              type="button"
                              onClick={() => handleToggleOpposite(code)}
                              className="hover:text-sg-danger"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                        {(!selectedSeat.opposite_codes || selectedSeat.opposite_codes.length === 0) && (
                          <span className="text-[11px] text-sg-muted italic">無指定對面</span>
                        )}
                      </div>
                      <select
                        data-testid="opposite-seat-select"
                        value=""
                        onChange={(e) => {
                          if (e.target.value) {
                            handleToggleOpposite(e.target.value);
                            e.target.value = '';
                          }
                        }}
                        className="w-full px-2.5 py-1 rounded-xl border border-sg-line text-[12px] font-bold bg-white"
                      >
                        <option value="">+ 新增對面座位...</option>
                        {(layout.seats || [])
                          .filter(s => s.code !== selectedSeat.code && !(selectedSeat.opposite_codes || []).includes(s.code))
                          .map(s => (
                            <option key={s.code} value={s.code}>
                              {s.code} {s.table_id == null ? '(單獨)' : ''}
                            </option>
                          ))}
                      </select>
                    </div>

                    {/* Tags */}
                    <div>
                      <label className="block text-sg-muted mb-1 font-medium">座位特色標記</label>
                      <div className="flex flex-wrap gap-1.5">
                        {['靠窗', '插座', '寬敞', '安靜'].map(tag => {
                          const hasTag = (selectedSeat.tags || []).includes(tag);
                          return (
                            <button
                              key={tag}
                              type="button"
                              onClick={() => {
                                const nextTags = hasTag
                                  ? selectedSeat.tags.filter(t => t !== tag)
                                  : [...(selectedSeat.tags || []), tag];
                                commitLayoutChange({
                                  ...layout,
                                  seats: layout.seats.map(s => s.code === selectedSeat.code ? { ...s, tags: nextTags } : s)
                                });
                              }}
                              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition ${
                                hasTag ? 'bg-sg-brown text-white border-sg-brown' : 'bg-sg-paper text-sg-ink border-sg-line'
                              }`}
                            >
                              {tag}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="pt-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedSeat.is_active === false}
                          onChange={(e) => {
                            const inactive = e.target.checked;
                            commitLayoutChange({
                              ...layout,
                              seats: layout.seats.map(s => s.code === selectedSeat.code ? { ...s, is_active: !inactive } : s)
                            });
                          }}
                          className="rounded text-sg-brown"
                        />
                        <span className="font-bold text-sg-danger text-[12px]">暫停使用此座位</span>
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {/* Background Image Inspector */}
              <div className="pt-3 border-t border-sg-line space-y-3 text-[13px]">
                <h4 className="font-bold text-sg-ink flex items-center justify-between">
                  <span>底圖設定</span>
                  {layout.background_image && (
                    <button
                      type="button"
                      onClick={() => {
                        commitLayoutChange({
                          ...layout,
                          background_image: null
                        });
                      }}
                      className="text-[11px] text-sg-danger hover:underline"
                    >
                      移除底圖
                    </button>
                  )}
                </h4>

                {layout.background_image ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-[12px] text-sg-muted">
                      <span>透明度：{layout.background_opacity ?? 40}%</span>
                    </div>
                    <input
                      type="range"
                      min="10"
                      max="80"
                      data-testid="bg-opacity-slider"
                      value={layout.background_opacity ?? 40}
                      onChange={(e) => {
                        setLayout(prev => ({
                          ...prev,
                          background_opacity: Number(e.target.value)
                        }));
                      }}
                      onMouseUp={() => commitLayoutChange(layout)}
                      onTouchEnd={() => commitLayoutChange(layout)}
                      className="w-full accent-sg-brown"
                    />
                  </div>
                ) : (
                  <div className="text-[12px] text-sg-muted">尚未上傳底圖（可匯入店內建築設計圖做為對齊依據）</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB: RULES & ALLOCATION PREVIEW (排位規則與試算) */}
      {activeTab === 'rules' && layout && (
        <div className="bg-white rounded-3xl border border-sg-line p-6 space-y-6 shadow-xs max-w-4xl mx-auto">
          <div className="border-b border-sg-line pb-3 flex items-center justify-between">
            <div>
              <h2 className="text-[17px] font-bold text-sg-ink">排位規則與試算預覽</h2>
              <p className="text-[12px] text-sg-muted mt-0.5">
                設定區域排位順序、同區分散規則與跨區策略，並可即時試算下一組排位。
              </p>
            </div>
          </div>

          {/* 1. 區域順序（拖曳調整） */}
          <div className="space-y-3">
            <h3 className="text-[14px] font-bold text-sg-ink flex items-center gap-1.5">
              <span>區域順序（拖曳調整）</span>
            </h3>
            <div className="space-y-2" data-testid="zone-order-list">
              {zoneOrderList.map((z, idx) => {
                const hasZoneItems = (layout?.tables || []).some(t => t.zone_id === z.id) ||
                  (layout?.seats || []).some(s => s.zone_id === z.id);
                const deleteDisabled = zoneOrderList.length <= 1 || hasZoneItems;
                const deleteTitle = hasZoneItems
                  ? '先把桌子移到其他區'
                  : zoneOrderList.length <= 1
                  ? '至少保留一個區域'
                  : '刪除區域';
                const isEditing = editingZoneId === z.id;

                return (
                  <div
                    key={z.id}
                    data-testid={`zone-row-${z.name}`}
                    draggable={!isEditing}
                    onDragStart={() => {
                      if (!isEditing) setDraggedZoneIdx(idx);
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (draggedZoneIdx != null && draggedZoneIdx !== idx) {
                        moveZone(draggedZoneIdx, idx);
                        setDraggedZoneIdx(null);
                      }
                    }}
                    className="flex items-center justify-between p-3 bg-sg-paper rounded-2xl border border-sg-line hover:border-sg-brown/50 transition cursor-move"
                  >
                    <div className="flex items-center gap-2.5 flex-wrap min-w-0">
                      <GripVertical className="w-4 h-4 text-sg-muted flex-shrink-0" />
                      <span className="font-bold text-[14px] text-sg-ink font-num">{idx + 1}</span>
                      {isEditing ? (
                        <input
                          type="text"
                          autoFocus
                          maxLength={10}
                          data-testid="edit-zone-name-input"
                          value={editingZoneName}
                          onChange={(e) => setEditingZoneName(e.target.value)}
                          onMouseDown={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleConfirmRenameZone(z.id);
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              setEditingZoneId(null);
                              setZoneError('');
                            }
                          }}
                          onBlur={() => handleConfirmRenameZone(z.id)}
                          className="px-2.5 py-0.5 rounded-lg border border-sg-brown bg-white font-bold text-[14px] text-sg-ink w-32 focus:outline-none"
                        />
                      ) : (
                        <button
                          type="button"
                          data-testid={`zone-name-${z.name}`}
                          onClick={() => handleStartRenameZone(z)}
                          title="點擊修改區域名稱"
                          className="font-bold text-[14px] text-sg-ink hover:text-sg-brown hover:underline text-left cursor-pointer"
                        >
                          {z.name}
                        </button>
                      )}
                      <span className="text-[12px] text-sg-muted">· {getZoneTableSummary(z.id)}</span>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => moveZone(idx, idx - 1)}
                        className="p-1.5 rounded-lg hover:bg-white text-sg-muted disabled:opacity-30"
                        title="上移"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={idx === zoneOrderList.length - 1}
                        onClick={() => moveZone(idx, idx + 1)}
                        className="p-1.5 rounded-lg hover:bg-white text-sg-muted disabled:opacity-30"
                        title="下移"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                      <span title={deleteTitle} className="inline-flex">
                        <button
                          type="button"
                          data-testid={`delete-zone-btn-${z.name}`}
                          disabled={deleteDisabled}
                          onClick={() => handleDeleteZone(z.id)}
                          title={deleteTitle}
                          aria-label={deleteTitle}
                          className="p-1.5 rounded-lg hover:bg-sg-danger-soft text-sg-danger disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </span>
                    </div>
                  </div>
                );
              })}

              {zoneError && (
                <div data-testid="zone-error-msg" className="text-[12px] font-bold text-sg-danger px-1">
                  {zoneError}
                </div>
              )}

              {isAddingZone ? (
                <div className="flex items-center gap-2 p-3 bg-white rounded-2xl border border-sg-brown/60">
                  <input
                    type="text"
                    autoFocus
                    maxLength={10}
                    data-testid="new-zone-name-input"
                    value={newZoneName}
                    onChange={(e) => setNewZoneName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleConfirmAddZone();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setIsAddingZone(false);
                        setZoneError('');
                      }
                    }}
                    placeholder="輸入區域名稱（1～10 字）"
                    className="flex-1 max-w-[180px] px-3 py-1.5 rounded-xl border border-sg-line text-[13px] font-bold text-sg-ink focus:outline-none focus:border-sg-brown"
                  />
                  <button
                    type="button"
                    data-testid="confirm-add-zone-btn"
                    onClick={handleConfirmAddZone}
                    className="px-3 py-1.5 rounded-xl bg-sg-brown text-white text-[12px] font-bold hover:bg-sg-brown/90 transition"
                  >
                    加入
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsAddingZone(false);
                      setZoneError('');
                    }}
                    className="px-2.5 py-1.5 rounded-xl text-[12px] font-bold text-sg-muted hover:text-sg-ink"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  data-testid="add-zone-btn"
                  onClick={handleStartAddZone}
                  className="w-full py-2.5 rounded-2xl border border-dashed border-sg-line text-[13px] font-bold text-sg-brown hover:bg-sg-paper hover:border-sg-brown/50 transition flex items-center justify-center gap-1"
                >
                  ＋ 新增區域
                </button>
              )}
            </div>
          </div>

          {/* 2. 同一區裡怎麼排 */}
          <div className="space-y-3 pt-2 border-t border-sg-line">
            <h3 className="text-[14px] font-bold text-sg-ink">同一區裡怎麼排</h3>
            <div className="space-y-2.5">
              <label className="flex items-center gap-2.5 cursor-pointer text-[13px] text-sg-ink">
                <input
                  type="checkbox"
                  data-testid="rule-spread-tables"
                  checked={layoutRules.spread_tables}
                  onChange={(e) => {
                    const next = { ...layoutRules, spread_tables: e.target.checked };
                    setLayoutRules(next);
                    handleTestAllocation(testPax, next, zoneOrderList);
                  }}
                  className="w-4 h-4 accent-sg-brown rounded"
                />
                <span className="font-medium">小組先坐空桌的一側，桌子之間左右交錯（桌 1 左、桌 2 右、桌 3 左）</span>
              </label>

              <label className="flex items-center gap-2.5 cursor-pointer text-[13px] text-sg-ink">
                <input
                  type="checkbox"
                  data-testid="rule-avoid-opposite"
                  checked={layoutRules.avoid_opposite}
                  onChange={(e) => {
                    const next = { ...layoutRules, avoid_opposite: e.target.checked };
                    setLayoutRules(next);
                    handleTestAllocation(testPax, next, zoneOrderList);
                  }}
                  className="w-4 h-4 accent-sg-brown rounded"
                />
                <span className="font-medium">每張桌都有人之後，才排對面有人的位置</span>
              </label>

              <label className="flex items-center gap-2.5 cursor-pointer text-[13px] text-sg-ink">
                <input
                  type="checkbox"
                  data-testid="rule-avoid-beside"
                  checked={layoutRules.avoid_beside}
                  onChange={(e) => {
                    const next = { ...layoutRules, avoid_beside: e.target.checked };
                    setLayoutRules(next);
                    handleTestAllocation(testPax, next, zoneOrderList);
                  }}
                  className="w-4 h-4 accent-sg-brown rounded"
                />
                <span className="font-medium">盡量不讓陌生人並排坐</span>
              </label>
            </div>
          </div>

          {/* 3. 跨區排位選項 */}
          {(() => {
            const zonesCount = zoneOrderList.length || layout?.zones?.length || 0;
            const hasThreeOrMoreZones = zonesCount >= 3;
            const firstZoneName = zoneOrderList[0]?.name || layout?.zones?.[0]?.name || '前區';
            const secondZoneName = zoneOrderList[1]?.name || layout?.zones?.[1]?.name || '後區';
            return (
              <div className="space-y-3 pt-2 border-t border-sg-line">
                <h3 className="text-[14px] font-bold text-sg-ink">
                  {hasThreeOrMoreZones ? '前面的區域每桌都有人之後' : `${firstZoneName}每桌都有人之後`}
                </h3>
                <div className="space-y-2.5">
                  <label className="flex items-center gap-2.5 cursor-pointer text-[13px] text-sg-ink">
                    <input
                      type="radio"
                      name="zone_mode"
                      value="empty_tables_first"
                      checked={layoutRules.zone_mode === 'empty_tables_first' || layoutRules.zone_mode === 'spread_across_zones'}
                      onChange={(e) => {
                        const next = { ...layoutRules, zone_mode: e.target.value };
                        setLayoutRules(next);
                        handleTestAllocation(testPax, next, zoneOrderList);
                      }}
                      className="w-4 h-4 accent-sg-brown"
                    />
                    <span className="font-medium">
                      {hasThreeOrMoreZones
                        ? '前面的區域每桌都有人之後，先用下一區的空桌，最後才排對面'
                        : `先用${secondZoneName}的空桌，最後才排對面（已採用）`}
                    </span>
                  </label>

                  <label className="flex items-center gap-2.5 cursor-pointer text-[13px] text-sg-ink">
                    <input
                      type="radio"
                      name="zone_mode"
                      value="fill_zone_first"
                      checked={layoutRules.zone_mode === 'fill_zone_first'}
                      onChange={(e) => {
                        const next = { ...layoutRules, zone_mode: e.target.value };
                        setLayoutRules(next);
                        handleTestAllocation(testPax, next, zoneOrderList);
                      }}
                      className="w-4 h-4 accent-sg-brown"
                    />
                    <span className="font-medium">
                      {hasThreeOrMoreZones
                        ? '前面的區域坐滿才排下一區'
                        : `${firstZoneName}全部坐滿才排${secondZoneName}`}
                    </span>
                  </label>
                </div>
              </div>
            );
          })()}

          {/* 4. 人數說明（逐字） */}
          <div className="p-3.5 bg-sg-paper rounded-2xl border border-sg-line text-[13px] text-sg-ink leading-relaxed">
            4 位坐整張空桌 · 3 位坐一側加對面一位 · 5 位以上坐同區相鄰兩桌。冷氣出風口等「最後才排」的座位，其他座位都滿了才會用。
          </div>

          {/* 5. 進階：分數 */}
          <div className="pt-2 border-t border-sg-line">
            <button
              type="button"
              onClick={() => setShowAdvancedWeights(v => !v)}
              className="flex items-center gap-1.5 text-[13px] font-bold text-sg-muted hover:text-sg-ink transition"
            >
              {showAdvancedWeights ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              <span>進階：分數</span>
            </button>

            {showAdvancedWeights && (
              <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 p-4 bg-sg-paper rounded-2xl border border-sg-line text-[12px]">
                <div>
                  <label className="font-bold text-sg-muted block mb-1">換區 (zone)</label>
                  <input
                    type="number"
                    value={layoutRules.weights?.zone ?? DEFAULT_WEIGHTS.zone}
                    onChange={(e) => {
                      const w = { ...layoutRules.weights, zone: Number(e.target.value) || 0 };
                      const next = { ...layoutRules, weights: w };
                      setLayoutRules(next);
                      handleTestAllocation(testPax, next, zoneOrderList);
                    }}
                    className="w-full px-2.5 py-1 rounded-xl border border-sg-line bg-white font-num font-bold"
                  />
                </div>
                <div>
                  <label className="font-bold text-sg-muted block mb-1">坐滿前區 (zone_fill_first)</label>
                  <input
                    type="number"
                    value={layoutRules.weights?.zone_fill_first ?? DEFAULT_WEIGHTS.zone_fill_first}
                    onChange={(e) => {
                      const w = { ...layoutRules.weights, zone_fill_first: Number(e.target.value) || 0 };
                      const next = { ...layoutRules, weights: w };
                      setLayoutRules(next);
                      handleTestAllocation(testPax, next, zoneOrderList);
                    }}
                    className="w-full px-2.5 py-1 rounded-xl border border-sg-line bg-white font-num font-bold"
                  />
                </div>
                <div>
                  <label className="font-bold text-sg-muted block mb-1">對面有人 (opposite)</label>
                  <input
                    type="number"
                    value={layoutRules.weights?.opposite ?? DEFAULT_WEIGHTS.opposite}
                    onChange={(e) => {
                      const w = { ...layoutRules.weights, opposite: Number(e.target.value) || 0 };
                      const next = { ...layoutRules, weights: w };
                      setLayoutRules(next);
                      handleTestAllocation(testPax, next, zoneOrderList);
                    }}
                    className="w-full px-2.5 py-1 rounded-xl border border-sg-line bg-white font-num font-bold"
                  />
                </div>
                <div>
                  <label className="font-bold text-sg-muted block mb-1">緊鄰有人 (beside)</label>
                  <input
                    type="number"
                    value={layoutRules.weights?.beside ?? DEFAULT_WEIGHTS.beside}
                    onChange={(e) => {
                      const w = { ...layoutRules.weights, beside: Number(e.target.value) || 0 };
                      const next = { ...layoutRules, weights: w };
                      setLayoutRules(next);
                      handleTestAllocation(testPax, next, zoneOrderList);
                    }}
                    className="w-full px-2.5 py-1 rounded-xl border border-sg-line bg-white font-num font-bold"
                  />
                </div>
                <div>
                  <label className="font-bold text-sg-muted block mb-1">次選 (second)</label>
                  <input
                    type="number"
                    value={layoutRules.weights?.second ?? DEFAULT_WEIGHTS.second}
                    onChange={(e) => {
                      const w = { ...layoutRules.weights, second: Number(e.target.value) || 0 };
                      const next = { ...layoutRules, weights: w };
                      setLayoutRules(next);
                      handleTestAllocation(testPax, next, zoneOrderList);
                    }}
                    className="w-full px-2.5 py-1 rounded-xl border border-sg-line bg-white font-num font-bold"
                  />
                </div>
                <div>
                  <label className="font-bold text-sg-muted block mb-1">避開 (last)</label>
                  <input
                    type="number"
                    value={layoutRules.weights?.last ?? DEFAULT_WEIGHTS.last}
                    onChange={(e) => {
                      const w = { ...layoutRules.weights, last: Number(e.target.value) || 0 };
                      const next = { ...layoutRules, weights: w };
                      setLayoutRules(next);
                      handleTestAllocation(testPax, next, zoneOrderList);
                    }}
                    className="w-full px-2.5 py-1 rounded-xl border border-sg-line bg-white font-num font-bold"
                  />
                </div>
                <div>
                  <label className="font-bold text-sg-muted block mb-1">拆桌 (split)</label>
                  <input
                    type="number"
                    value={layoutRules.weights?.split ?? DEFAULT_WEIGHTS.split}
                    onChange={(e) => {
                      const w = { ...layoutRules.weights, split: Number(e.target.value) || 0 };
                      const next = { ...layoutRules, weights: w };
                      setLayoutRules(next);
                      handleTestAllocation(testPax, next, zoneOrderList);
                    }}
                    className="w-full px-2.5 py-1 rounded-xl border border-sg-line bg-white font-num font-bold"
                  />
                </div>
              </div>
            )}
          </div>

          {/* 6. 預覽：下一組 [{testPax}] 位會排到哪 */}
          <div className="space-y-4 pt-2 border-t border-sg-line">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-[15px] font-bold text-sg-ink flex items-center gap-2">
                <span>預覽：下一組 [{testPax}] 位會排到哪</span>
              </h3>

              {/* Stepper */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="pax-minus-btn"
                  disabled={testPax <= 1}
                  onClick={() => {
                    const p = Math.max(1, testPax - 1);
                    setTestPax(p);
                    handleTestAllocation(p, layoutRules, zoneOrderList);
                  }}
                  className="w-8 h-8 rounded-xl border border-sg-line bg-white font-bold flex items-center justify-center hover:bg-sg-paper disabled:opacity-40 text-sg-ink transition"
                >
                  -
                </button>
                <input
                  type="number"
                  min="1"
                  max="12"
                  data-testid="preview-pax-input"
                  value={testPax}
                  onChange={(e) => {
                    const p = Math.max(1, Math.min(12, Number(e.target.value) || 1));
                    setTestPax(p);
                    handleTestAllocation(p, layoutRules, zoneOrderList);
                  }}
                  className="w-12 text-center font-bold text-[15px] font-num text-sg-ink bg-white border border-sg-line rounded-xl py-1"
                />
                <button
                  type="button"
                  data-testid="pax-plus-btn"
                  disabled={testPax >= 12}
                  onClick={() => {
                    const p = Math.min(12, testPax + 1);
                    setTestPax(p);
                    handleTestAllocation(p, layoutRules, zoneOrderList);
                  }}
                  className="w-8 h-8 rounded-xl border border-sg-line bg-white font-bold flex items-center justify-center hover:bg-sg-paper disabled:opacity-40 text-sg-ink transition"
                >
                  +
                </button>
                <span className="text-[13px] text-sg-muted">位</span>
                <button
                  type="button"
                  data-testid="run-preview-alloc-btn"
                  onClick={() => handleTestAllocation(testPax, layoutRules, zoneOrderList)}
                  className="ml-2 px-3 py-1 rounded-xl bg-sg-brown text-white text-[12px] font-bold hover:bg-sg-brown-dark transition shadow-xs"
                >
                  試算
                </button>
              </div>
            </div>

            {/* Layout demo mode preview */}
            <div data-testid="preview-alloc-result" className="p-4 rounded-2xl bg-sg-paper border border-sg-line space-y-4">
              {testing ? (
                <div className="py-8 text-center text-sg-muted text-[13px]">試算中...</div>
              ) : (
                <div className="space-y-4">
                  {zoneOrderList.map(zone => {
                    const zTables = (layout.tables || []).filter(t => t.zone_id === zone.id);
                    const zStandaloneSeats = (layout.seats || []).filter(s => s.zone_id === zone.id && s.table_id == null);
                    if (zTables.length === 0 && zStandaloneSeats.length === 0) return null;

                    return (
                      <div key={zone.id} className="space-y-2">
                        <div className="text-[12px] font-bold text-sg-muted">
                          {zone.name}
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                          {zTables.map(t => {
                            const tSeats = (layout.seats || []).filter(s => s.table_id === t.id);
                            return (
                              <div key={t.id} className="p-3 bg-white rounded-xl border border-sg-line shadow-2xs space-y-2">
                                <div className="text-[13px] font-bold text-sg-ink flex items-center justify-between">
                                  <span>{t.label}</span>
                                  <span className="text-[11px] text-sg-muted font-normal">{tSeats.length} 人桌</span>
                                </div>
                                <div className="grid grid-cols-2 gap-1.5">
                                  {tSeats.map(s => {
                                    const isAllocated = (testResult?.seats || testResult?.allocatedSeats || []).includes(s.code);
                                    const isOccupied = !isAllocated && (testResult?.occupancy?.[s.code] || false);

                                    return (
                                      <div
                                        key={s.code}
                                        data-testid={`preview-seat-${s.code}`}
                                        className={`px-2 py-1 rounded-lg text-center text-[12px] font-bold transition flex items-center justify-center gap-1 ${
                                          isAllocated
                                            ? 'bg-sg-sage text-white ring-2 ring-sg-sage/40 shadow-xs'
                                            : isOccupied
                                            ? 'bg-sg-paper text-sg-muted border border-sg-line line-through'
                                            : 'bg-white text-sg-ink border border-sg-line'
                                        }`}
                                      >
                                        {isAllocated ? `★ 建議 ${s.code}` : isOccupied ? `已佔用 ${s.code}` : s.code}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}

                          {zStandaloneSeats.length > 0 && (
                            <div className="p-3 bg-white rounded-xl border border-sg-line shadow-2xs space-y-2">
                              <div className="text-[13px] font-bold text-sg-ink">單獨座位</div>
                              <div className="flex flex-wrap gap-1.5">
                                {zStandaloneSeats.map(s => {
                                  const isAllocated = (testResult?.seats || testResult?.allocatedSeats || []).includes(s.code);
                                  const isOccupied = !isAllocated && (testResult?.occupancy?.[s.code] || false);

                                  return (
                                    <div
                                      key={s.code}
                                      className={`px-2 py-1 rounded-lg text-center text-[12px] font-bold transition ${
                                        isAllocated
                                          ? 'bg-sg-sage text-white ring-2 ring-sg-sage/40 shadow-xs'
                                          : isOccupied
                                          ? 'bg-sg-paper text-sg-muted border border-sg-line line-through'
                                          : 'bg-white text-sg-ink border border-sg-line'
                                      }`}
                                    >
                                      {isAllocated ? `★ 建議 ${s.code}` : isOccupied ? `已佔用 ${s.code}` : s.code}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {/* Reason & allocation info */}
                  {testResult && (
                    <div className="pt-2 border-t border-sg-line space-y-1">
                      {testResult.reason ? (
                        <div className="text-[13px] font-bold text-sg-ink flex items-center gap-1.5">
                          <Check className="w-4 h-4 text-sg-sage" />
                          <span>建議原因：{testResult.reason}</span>
                        </div>
                      ) : (testResult.seats || testResult.allocatedSeats || []).length === 0 ? (
                        <div className="text-[13px] font-bold text-sg-danger flex items-center gap-1.5">
                          <AlertCircle className="w-4 h-4" /> 無法排位（無符合人數之連續或相鄰空位）
                        </div>
                      ) : null}
                      <div className="text-[12px] text-sg-muted">
                        排位得分：<span className="font-bold text-sg-ink font-num">{testResult.score ?? 0}</span>
                      </div>
                    </div>
                  )}

                  {/* Verbatim disclaimer */}
                  <div className="text-[12px] text-sg-muted">
                    試算的是「現在」這個時段，實際排位時會檢查整段預約時間都有空。
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 7. 主按鈕「儲存」，立即生效 */}
          <div className="pt-2 border-t border-sg-line">
            <button
              type="button"
              data-testid="save-rules-btn"
              onClick={handleSaveRules}
              disabled={savingRules}
              className="w-full py-3 rounded-2xl bg-sg-brown text-white font-bold text-[15px] hover:bg-sg-brown/90 transition shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <Save className="w-4 h-4" />
              <span>{savingRules ? '儲存中...' : '儲存排位規則'}</span>
            </button>
          </div>
        </div>
      )}

      {/* TAB 2: MOBILE LIST MODE (清單模式) */}
      {activeTab === 'mobile_list' && layout && (
        <div className="bg-white rounded-3xl border border-sg-line p-4 space-y-4 shadow-xs">
          <div className="flex items-center justify-between gap-2 pb-2 border-b border-sg-line flex-wrap">
            <h2 className="text-[16px] font-bold text-sg-ink">桌子與座位清單</h2>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-[11px] font-bold text-sg-muted">
                <span>放在：</span>
                <select
                  value={currentZoneId ?? ''}
                  onChange={(e) => {
                    const zId = Number(e.target.value);
                    currentZoneIdRef.current = zId;
                    setCurrentZoneId(zId);
                  }}
                  className="px-2 py-1 rounded-xl bg-white border border-sg-line font-bold text-sg-ink text-[12px]"
                >
                  {(zoneOrderList.length > 0 ? zoneOrderList : (layout.zones || [])).map(z => (
                    <option key={z.id} value={z.id}>{z.name}</option>
                  ))}
                </select>
              </label>
              <Button size="sm" variant="secondary" onClick={() => handleAddPreset('4p')}>
                <Plus className="w-4 h-4 mr-1" /> 新增 4 人桌
              </Button>
            </div>
          </div>

          <div className="space-y-4">
            {(layout.zones || []).map(zone => {
              const zoneTables = (layout.tables || []).filter(t => t.zone_id === zone.id);
              return (
                <div key={zone.id} className="space-y-2">
                  <div className="bg-sg-paper px-3 py-1.5 rounded-xl font-bold text-[13px] text-sg-ink flex items-center justify-between">
                    <span>{zone.name} {zone.note && `(${zone.note})`}</span>
                    <span className="text-[11px] text-sg-muted font-normal">{zoneTables.length} 張桌子</span>
                  </div>

                  <div className="space-y-2 pl-2">
                    {zoneTables.map(t => {
                      const tSeats = (layout.seats || []).filter(s => s.table_id === t.id);
                      return (
                        <div key={t.id} className="p-3 rounded-2xl border border-sg-line bg-white shadow-xs space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-[14px] text-sg-ink">{t.label} ({t.shape === 'round' ? '圓桌' : t.arrangement === 'one_side' ? '長桌' : '四人桌'})</span>
                            <span className="text-[12px] text-sg-muted font-num">{t.rotation || 0}°</span>
                          </div>

                          <div className="flex flex-wrap gap-1.5">
                            {tSeats.map(s => (
                              <button
                                key={s.code}
                                type="button"
                                onClick={() => setMobileEditingSeat(s)}
                                className={`px-2.5 py-1 rounded-xl text-[12px] font-bold border transition ${
                                  s.is_active === false ? 'bg-sg-paper text-sg-muted border-sg-line line-through' : 'bg-white text-sg-ink border-sg-line hover:border-sg-brown'
                                }`}
                              >
                                {s.code}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Publish Impact Confirmation Dialog */}
      <ConfirmPanel
        isOpen={showPublishConfirm}
        onClose={() => setShowPublishConfirm(false)}
        onConfirm={handleConfirmPublish}
        title="發布座位版面生效確認"
        confirmText="發布並套用新座位"
        cancelText="先不要"
        variant="primary"
        loading={saving}
      >
        <div className="space-y-3.5 text-[13px] max-h-[70vh] overflow-y-auto pr-1">
          {previewPublishData && (
            <div className="bg-sg-paper p-3 rounded-2xl border border-sg-line text-[12px] space-y-1.5">
              <div className="text-sg-muted">
                生效日期：<span className="font-bold text-sg-brown">{publishDate}</span>
              </div>
              {previewPublishData.sessions_capacity_exceeding_seats_count > 0 && (
                <div className="text-amber-800 font-bold bg-amber-50 border border-amber-200 rounded-xl p-2.5 flex items-center gap-1.5" data-testid="publish-capacity-warning">
                  <AlertTriangle className="w-4 h-4 text-amber-700 flex-shrink-0" />
                  <span>
                    {(publishDate ? `${parseInt(publishDate.split('-')[1], 10)}/${parseInt(publishDate.split('-')[2], 10)}` : '')} 起有 {previewPublishData.sessions_capacity_exceeding_seats_count} 個時段的可預約人數比座位多
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Category C: 需要換座位的在場客人 */}
          {previewPublishData?.category_c?.length > 0 && (
            <div className="space-y-2">
              <div>
                <div className="font-bold text-sg-ink text-[13px]">需要換座位的在場客人</div>
                <div className="text-[11px] text-sg-muted">發布後請帶客人移到新座位，計時不會中斷</div>
              </div>
              <div className="space-y-1.5">
                {previewPublishData.category_c.map((c) => {
                  const currentTo = (manualOverrides[c.booking_ref] || c.to || []).join('、');
                  const fromStr = (c.from || []).join('、');
                  const isEditing = editingOverrideRef === c.booking_ref;

                  return (
                    <div key={c.booking_ref} className="p-2.5 rounded-xl border border-sg-line bg-white space-y-2">
                      <div className="flex items-center justify-between text-[12px]">
                        <div>
                          <span className="font-bold text-sg-ink">{c.name}</span>
                          <span className="text-sg-muted"> · {c.pax} 位：</span>
                          <span className="text-sg-muted">{fromStr}</span>
                          <span className="mx-1 text-sg-brown font-bold">→</span>
                          <span className="font-bold text-sg-brown font-num">{currentTo}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setEditingOverrideRef(isEditing ? null : c.booking_ref)}
                          className="px-2.5 py-0.5 rounded-lg border border-sg-line text-[11px] font-bold text-sg-ink hover:bg-sg-paper transition shadow-2xs"
                        >
                          {isEditing ? '完成' : '改'}
                        </button>
                      </div>

                      {/* Seat picker if editing */}
                      {isEditing && (
                        <div className="pt-2 border-t border-sg-line space-y-1.5">
                          <label className="text-[11px] text-sg-muted block">挑選新座位（需選 {c.pax} 個）：</label>
                          <div className="flex flex-wrap gap-1.5">
                            {(layout?.seats || []).filter(s => s.is_active).map(s => {
                              const selected = (manualOverrides[c.booking_ref] || c.to || []).includes(s.code);
                              return (
                                <button
                                  key={s.code}
                                  type="button"
                                  onClick={() => {
                                    const currentList = manualOverrides[c.booking_ref] || [...c.to];
                                    let nextList;
                                    if (currentList.includes(s.code)) {
                                      nextList = currentList.filter(x => x !== s.code);
                                    } else {
                                      if (currentList.length >= c.pax) {
                                        nextList = [...currentList.slice(1), s.code];
                                      } else {
                                        nextList = [...currentList, s.code];
                                      }
                                    }
                                    setManualOverrides(prev => ({ ...prev, [c.booking_ref]: nextList }));
                                  }}
                                  className={`px-2 py-1 rounded-lg text-[11px] font-bold border transition ${
                                    selected ? 'bg-sg-brown text-white border-sg-brown' : 'bg-sg-paper text-sg-ink border-sg-line hover:border-sg-brown'
                                  }`}
                                >
                                  {s.code}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Category B: 會自動改排的預約 */}
          {previewPublishData?.category_b?.length > 0 && (
            <div className="space-y-2">
              <div className="font-bold text-sg-ink text-[13px]">會自動改排的預約</div>
              <div className="space-y-1.5">
                {previewPublishData.category_b.map((b) => {
                  const fromStr = (b.from || []).join('、');
                  const toStr = (b.to || []).join('、');
                  const timeStr = b.time ? ` ${b.time}：` : '：';
                  return (
                    <div key={b.booking_ref} className="p-2.5 rounded-xl border border-sg-line bg-white text-[12px]">
                      <span className="font-bold text-sg-ink">{b.name}</span>
                      <span className="text-sg-muted">{timeStr}</span>
                      <span className="text-sg-muted">{fromStr}</span>
                      <span className="mx-1 text-sg-brown font-bold">→</span>
                      <span className="font-bold text-sg-brown font-num">{toStr}</span>
                      {b.note && (
                        <span className="ml-1.5 text-[11px] text-sg-muted font-bold">（{b.note}）</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Needs Manual: 放進等待區、需要手動帶位 */}
          {previewPublishData?.needs_manual?.length > 0 && (
            <div className="space-y-2">
              <div className="font-bold text-amber-900 text-[13px]">放進等待區、需要手動帶位</div>
              <div className="space-y-1.5">
                {previewPublishData.needs_manual.map((m) => {
                  const fromStr = (m.from || []).join('、');
                  const toStr = (m.to || []).join('、');
                  return (
                    <div key={m.booking_ref} className="p-2.5 rounded-xl border border-amber-200 bg-amber-50 text-[12px] text-amber-950">
                      <span className="font-bold">{m.name}</span>
                      <span className="text-amber-800"> · {m.pax} 位：</span>
                      <span>{fromStr}</span>
                      <span className="mx-1 font-bold">→</span>
                      <span className="font-bold font-num">{toStr}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </ConfirmPanel>
    </div>
  );
}
