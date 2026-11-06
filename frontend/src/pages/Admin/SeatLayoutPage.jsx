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
  Columns
} from 'lucide-react';
import api from '../../api/axios';
import SegmentedTabs from '../../components/admin/SegmentedTabs';
import ResponsivePanel from '../../components/admin/ResponsivePanel';
import ConfirmPanel from '../../components/admin/ConfirmPanel';
import Button from '../../components/customer/Button';

export default function SeatLayoutPage() {
  const [activeTab, setActiveTab] = useState('editor'); // 'editor' | 'rules' | 'mobile_list'
  const [layout, setLayout] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  // History for Undo / Redo (up to 50 steps)
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Selection state
  const [selectedTableId, setSelectedTableId] = useState(null);
  const [selectedSeatCode, setSelectedSeatCode] = useState(null);
  const [selectedElementId, setSelectedElementId] = useState(null);
  const [multiSelectedTableIds, setMultiSelectedTableIds] = useState([]);

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
  const [publishDate, setPublishDate] = useState(() => new Date().toISOString().slice(0, 10));

  // Allocation test state
  const [testPax, setTestPax] = useState(2);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  // Mobile sheet for seat property edit
  const [mobileEditingSeat, setMobileEditingSeat] = useState(null);

  const svgRef = useRef(null);
  const fileInputRef = useRef(null);

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
        const activeRes = await api.get('/seat-layouts/active');
        loadedLayout = activeRes.data;
      }

      if (loadedLayout) {
        // Ensure elements_json is array
        if (!loadedLayout.elements_json && loadedLayout.elements) {
          loadedLayout.elements_json = loadedLayout.elements;
        }
        if (!Array.isArray(loadedLayout.elements_json)) {
          loadedLayout.elements_json = [];
        }
        setLayout(loadedLayout);
        setHistory([JSON.parse(JSON.stringify(loadedLayout))]);
        setHistoryIndex(0);
        if (loadedLayout.zones?.length > 0) {
          setCurrentZoneId(loadedLayout.zones[0].id);
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
    const cloned = JSON.parse(JSON.stringify(newLayout));
    setHistory(prev => {
      const next = prev.slice(0, historyIndex + 1);
      if (next.length >= 50) next.shift();
      next.push(cloned);
      return next;
    });
    setHistoryIndex(prev => Math.min(prev + 1, 49));
    setLayout(cloned);
  }, [historyIndex]);

  // Undo
  const handleUndo = useCallback(() => {
    if (historyIndex > 0) {
      const targetIndex = historyIndex - 1;
      const targetLayout = JSON.parse(JSON.stringify(history[targetIndex]));
      setHistoryIndex(targetIndex);
      setLayout(targetLayout);
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
    if (!layout) return;
    try {
      setSaving(true);
      let targetId = layout.id;
      // If active layout is published, create draft on backend first
      if (layout.status === 'published') {
        const draftRes = await api.post('/seat-layouts/draft', { from_id: layout.id });
        targetId = draftRes.data.layout_id;
      }
      const res = await api.put(`/seat-layouts/${targetId}`, layout);
      setLayout(res.data.layout);
      setMessage({ type: 'success', text: '草稿儲存成功！' });
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || '儲存失敗' });
    } finally {
      setSaving(false);
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
        confirm: true
      });
      setShowPublishConfirm(false);
      setLayout(res.data.layout);
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
    if (e.target === svgRef.current || e.target.id === 'canvas-bg') {
      if (!e.shiftKey) {
        setSelectedTableId(null);
        setSelectedSeatCode(null);
        setSelectedElementId(null);
        setMultiSelectedTableIds([]);
      }
      setMarquee({ startX: x, startY: y, currentX: x, currentY: y });
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

    if (dragInfo.mode === 'move_table') {
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
        const selected = (layout?.tables || []).filter(t => {
          return t.cx >= minX && t.cx <= maxX && t.cy >= minY && t.cy <= maxY;
        }).map(t => t.id);
        setMultiSelectedTableIds(selected);
        if (selected.length === 1) {
          setSelectedTableId(selected[0]);
        }
      }
      setMarquee(null);
    }

    // End Drag
    if (dragInfo) {
      commitLayoutChange(layout);
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
    
    // Find next table number / label
    let nextNum = 1;
    while (existingTableLabels.includes(String(nextNum)) || existingTableLabels.includes(`桌 ${nextNum}`)) {
      nextNum++;
    }
    const tableLabel = `桌 ${nextNum}`;
    const tableKey = `table_${Date.now()}`;
    const zoneId = currentZoneId || layout.zones?.[0]?.id || 1;

    let newTable = null;
    let newSeats = [];

    const cx = 300 + (layout.tables?.length || 0) * 20;
    const cy = 250;

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
        { code: `${nextNum}-1`, table_id: newTable.id, zone_id: zoneId, lx: -45, ly: -35, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
        { code: `${nextNum}-2`, table_id: newTable.id, zone_id: zoneId, lx: -45, ly: 35, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
        { code: `${nextNum}-3`, table_id: newTable.id, zone_id: zoneId, lx: 45, ly: -35, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 2 },
        { code: `${nextNum}-4`, table_id: newTable.id, zone_id: zoneId, lx: 45, ly: 35, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 3 },
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
        { code: `${nextNum}-1`, table_id: newTable.id, zone_id: zoneId, lx: -40, ly: -90, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
        { code: `${nextNum}-2`, table_id: newTable.id, zone_id: zoneId, lx: -40, ly: -30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
        { code: `${nextNum}-3`, table_id: newTable.id, zone_id: zoneId, lx: -40, ly: 30, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 2 },
        { code: `${nextNum}-4`, table_id: newTable.id, zone_id: zoneId, lx: -40, ly: 90, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 3 },
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
        { code: `${nextNum}-1`, table_id: newTable.id, zone_id: zoneId, lx: -r, ly: 0, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 },
        { code: `${nextNum}-2`, table_id: newTable.id, zone_id: zoneId, lx: 0, ly: -r, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 1 },
        { code: `${nextNum}-3`, table_id: newTable.id, zone_id: zoneId, lx: r, ly: 0, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 2 },
        { code: `${nextNum}-4`, table_id: newTable.id, zone_id: zoneId, lx: 0, ly: r, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 3 },
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
        { code: `${nextNum}-1`, table_id: newTable.id, zone_id: zoneId, lx: 0, ly: 0, side_mode: 'auto', priority: 'normal', is_active: true, sort_order: 0 }
      ];
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
    setMessage({ type: 'success', text: `已複製為 ${newLabel}` });
  };

  const handleDeleteTable = (tableId) => {
    commitLayoutChange({
      ...layout,
      tables: layout.tables.filter(t => t.id !== tableId),
      seats: layout.seats.filter(s => s.table_id !== tableId)
    });
    setSelectedTableId(null);
    setSelectedSeatCode(null);
    setMessage({ type: 'success', text: '已刪除桌子' });
  };

  const handleDeleteElement = (elementId) => {
    commitLayoutChange({
      ...layout,
      elements_json: (layout.elements_json || []).filter(el => el.id !== elementId)
    });
    setSelectedElementId(null);
    setMessage({ type: 'success', text: '已刪除環境物件' });
  };

  // Alignment Tools (multi-selected tables)
  const handleAlign = (type) => {
    const selected = (layout.tables || []).filter(t => multiSelectedTableIds.includes(t.id));
    if (selected.length < 2) return;

    let updatedTables = [...layout.tables];

    if (type === 'left') {
      const minLeft = Math.min(...selected.map(t => t.cx - t.w / 2));
      updatedTables = updatedTables.map(t => multiSelectedTableIds.includes(t.id) ? { ...t, cx: minLeft + t.w / 2 } : t);
    } else if (type === 'center_h') {
      const avgCx = Math.round(selected.reduce((sum, t) => sum + t.cx, 0) / selected.length);
      updatedTables = updatedTables.map(t => multiSelectedTableIds.includes(t.id) ? { ...t, cx: avgCx } : t);
    } else if (type === 'right') {
      const maxRight = Math.max(...selected.map(t => t.cx + t.w / 2));
      updatedTables = updatedTables.map(t => multiSelectedTableIds.includes(t.id) ? { ...t, cx: maxRight - t.w / 2 } : t);
    } else if (type === 'top') {
      const minTop = Math.min(...selected.map(t => t.cy - t.h / 2));
      updatedTables = updatedTables.map(t => multiSelectedTableIds.includes(t.id) ? { ...t, cy: minTop + t.h / 2 } : t);
    } else if (type === 'center_v') {
      const avgCy = Math.round(selected.reduce((sum, t) => sum + t.cy, 0) / selected.length);
      updatedTables = updatedTables.map(t => multiSelectedTableIds.includes(t.id) ? { ...t, cy: avgCy } : t);
    } else if (type === 'bottom') {
      const maxBottom = Math.max(...selected.map(t => t.cy + t.h / 2));
      updatedTables = updatedTables.map(t => multiSelectedTableIds.includes(t.id) ? { ...t, cy: maxBottom - t.h / 2 } : t);
    } else if (type === 'dist_h') {
      const sorted = [...selected].sort((a, b) => a.cx - b.cx);
      const minCx = sorted[0].cx;
      const maxCx = sorted[sorted.length - 1].cx;
      const step = (maxCx - minCx) / (sorted.length - 1);
      sorted.forEach((t, i) => {
        const targetCx = Math.round(minCx + step * i);
        updatedTables = updatedTables.map(orig => orig.id === t.id ? { ...orig, cx: targetCx } : orig);
      });
    } else if (type === 'dist_v') {
      const sorted = [...selected].sort((a, b) => a.cy - b.cy);
      const minCy = sorted[0].cy;
      const maxCy = sorted[sorted.length - 1].cy;
      const step = (maxCy - minCy) / (sorted.length - 1);
      sorted.forEach((t, i) => {
        const targetCy = Math.round(minCy + step * i);
        updatedTables = updatedTables.map(orig => orig.id === t.id ? { ...orig, cy: targetCy } : orig);
      });
    }

    commitLayoutChange({ ...layout, tables: updatedTables });
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
            <h1 className="text-[18px] font-bold text-sg-ink">座位設定與平面圖編輯</h1>
            <span className={`text-[12px] px-2.5 py-0.5 rounded-full font-bold ${layout?.status === 'published' ? 'bg-sg-sage-soft text-sg-sage-ink' : 'bg-sg-honey-soft text-sg-honey'}`}>
              {layout?.status === 'published' ? '已發布生效中' : '編輯草稿中'}
            </span>
          </div>
          <div className="text-[12px] text-sg-muted mt-0.5">
            1 單位 = 1 公分 · 總座位數 <span className="font-bold text-sg-ink font-num">{layout?.seats?.filter(s => s.is_active !== false)?.length || 0}</span> 席
          </div>
        </div>

        <div className="flex items-center gap-2">
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

      {/* Mode Tabs */}
      <div className="flex items-center justify-between">
        <SegmentedTabs
          tabs={[
            { id: 'editor', label: '平面圖畫布', icon: <Layers className="w-4 h-4" /> },
            { id: 'mobile_list', label: '清單模式', icon: <Sliders className="w-4 h-4" /> }
          ]}
          activeTab={activeTab}
          onChange={setActiveTab}
        />

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
          <div className="bg-white p-2.5 rounded-2xl border border-sg-line shadow-xs flex flex-wrap items-center justify-between gap-2 text-[12px]">
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
          {multiSelectedTableIds.length >= 2 && (
            <div className="bg-white p-2.5 rounded-xl border border-sg-brown/40 shadow-xs flex items-center justify-between text-[12px] animate-fade-in">
              <span className="font-bold text-sg-ink">已選取 {multiSelectedTableIds.length} 張桌子</span>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => handleAlign('left')} title="靠左對齊" className="p-1.5 hover:bg-sg-paper rounded"><AlignLeft className="w-4 h-4" /></button>
                <button type="button" onClick={() => handleAlign('center_h')} title="水平置中" className="p-1.5 hover:bg-sg-paper rounded"><AlignCenter className="w-4 h-4" /></button>
                <button type="button" onClick={() => handleAlign('right')} title="靠右對齊" className="p-1.5 hover:bg-sg-paper rounded"><AlignRight className="w-4 h-4" /></button>
                <div className="h-3 w-px bg-sg-line mx-1" />
                <button type="button" onClick={() => handleAlign('top')} title="靠頂對齊" className="p-1.5 hover:bg-sg-paper rounded rotate-90"><AlignLeft className="w-4 h-4" /></button>
                <button type="button" onClick={() => handleAlign('center_v')} title="垂直置中" className="p-1.5 hover:bg-sg-paper rounded"><AlignVerticalJustifyCenter className="w-4 h-4" /></button>
                <button type="button" onClick={() => handleAlign('bottom')} title="靠底對齊" className="p-1.5 hover:bg-sg-paper rounded rotate-90"><AlignRight className="w-4 h-4" /></button>
                <div className="h-3 w-px bg-sg-line mx-1" />
                <button type="button" onClick={() => handleAlign('dist_h')} title="水平平均分布" className="p-1.5 hover:bg-sg-paper rounded"><AlignHorizontalJustifyCenter className="w-4 h-4" /></button>
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
                    const isSelected = selectedTableId === t.id || multiSelectedTableIds.includes(t.id);
                    const isRound = t.shape === 'round';

                    return (
                      <g
                        key={t.id}
                        data-testid={`table-node-${t.label}`}
                        transform={`rotate(${t.rotation || 0} ${t.cx} ${t.cy})`}
                        cursor="move"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          if (e.shiftKey) {
                            setMultiSelectedTableIds(prev =>
                              prev.includes(t.id) ? prev.filter(id => id !== t.id) : [...prev, t.id]
                            );
                          } else {
                            setSelectedTableId(t.id);
                            setSelectedSeatCode(null);
                            setSelectedElementId(null);
                          }
                          const coords = getCanvasCoords(e);
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
                    const rotLx = lx * Math.cos(tRot) - ly * Math.sin(tRot);
                    const rotLy = lx * Math.sin(tRot) + ly * Math.cos(tRot);

                    const cx = (table?.cx || 0) + rotLx;
                    const cy = (table?.cy || 0) + rotLy;

                    const isSelected = selectedSeatCode === seat.code;
                    const isInactive = seat.is_active === false;

                    return (
                      <g
                        key={seat.code}
                        data-testid={`seat-node-${seat.code}`}
                        transform={`rotate(${table?.rotation || 0} ${cx} ${cy})`}
                        cursor="grab"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          setSelectedSeatCode(seat.code);
                          setSelectedTableId(seat.table_id || null);
                          setSelectedElementId(null);
                          if (table) {
                            const coords = getCanvasCoords(e);
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
              {/* Properties for Selected Table */}
              {selectedTable && (
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
                        {(layout.zones || []).map(z => (
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
              {selectedSeat && (
                <div className="space-y-4 pt-2 border-t border-sg-line">
                  <div className="flex items-center justify-between pb-2 border-b border-sg-line">
                    <h3 className="text-[15px] font-bold text-sg-ink">座位設定 ({selectedSeat.code})</h3>
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

      {/* TAB 2: MOBILE LIST MODE (清單模式) */}
      {activeTab === 'mobile_list' && layout && (
        <div className="bg-white rounded-3xl border border-sg-line p-4 space-y-4 shadow-xs">
          <div className="flex items-center justify-between pb-2 border-b border-sg-line">
            <h2 className="text-[16px] font-bold text-sg-ink">桌子與座位清單</h2>
            <div className="flex items-center gap-2">
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
        confirmText="確認發布並排位"
        variant="primary"
      >
        <div className="space-y-3 text-[13px]">
          <p className="text-sg-ink">
            即將自 <span className="font-bold text-sg-brown">{publishDate}</span> 起發布新生效版面。
          </p>
          {previewPublishData && (
            <div className="bg-sg-paper p-3 rounded-2xl border border-sg-line space-y-1">
              <div>總容量：<span className="font-bold text-sg-ink font-num">{previewPublishData.capacity}</span> 席</div>
              <div>受影響時段預約：<span className="font-bold text-sg-ink font-num">{previewPublishData.impacted_bookings_count || 0}</span> 筆</div>
            </div>
          )}
        </div>
      </ConfirmPanel>
    </div>
  );
}
