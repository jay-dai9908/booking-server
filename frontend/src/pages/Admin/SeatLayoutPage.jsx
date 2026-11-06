import React, { useState, useEffect } from 'react';
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
  X
} from 'lucide-react';
import api from '../../api/axios';
import SegmentedTabs from '../../components/admin/SegmentedTabs';
import ResponsivePanel from '../../components/admin/ResponsivePanel';
import ConfirmPanel from '../../components/admin/ConfirmPanel';
import Button from '../../components/customer/Button';
import FloorPlan from '../../components/admin/floor/FloorPlan';

export default function SeatLayoutPage() {
  const [activeTab, setActiveTab] = useState('editor'); // 'editor' | 'rules'
  const [layout, setLayout] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedTable, setSelectedTable] = useState(null);
  const [selectedSeat, setSelectedSeat] = useState(null);
  const [previewPublishData, setPreviewPublishData] = useState(null);
  const [showPublishConfirm, setShowPublishConfirm] = useState(false);
  const [publishDate, setPublishDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [message, setMessage] = useState(null);

  // Allocation test state
  const [testPax, setTestPax] = useState(2);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    fetchActiveLayout();
  }, []);

  const fetchActiveLayout = async () => {
    try {
      setLoading(true);
      const res = await api.get('/seat-layouts/active');
      setLayout(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!layout || !layout.id) return;
    try {
      setSaving(true);
      const res = await api.put(`/seat-layouts/${layout.id}`, layout);
      setLayout(res.data.layout);
      setMessage({ type: 'success', text: '草稿儲存成功！' });
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || '儲存失敗' });
    } finally {
      setSaving(false);
    }
  };

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
      setMessage({ type: 'success', text: '版面發布成功！時段人數上限已同步更新。' });
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || '發布失敗' });
    } finally {
      setSaving(false);
    }
  };

  const handleRunAllocTest = async () => {
    try {
      setTesting(true);
      const res = await api.post('/seat-layouts/allocate-preview', {
        layout_id: layout.id,
        pax: testPax,
        session_id: 1
      });
      setTestResult(res.data);
    } catch (err) {
      setTestResult({ error: err.response?.data?.error || '排位試算失敗' });
    } finally {
      setTesting(false);
    }
  };

  const updateRules = (key, val) => {
    setLayout(prev => ({
      ...prev,
      rules_json: {
        ...(prev.rules_json || {}),
        [key]: val
      }
    }));
  };

  return (
    <div className="space-y-4 max-w-7xl mx-auto pb-12">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-3xl border border-sg-line shadow-xs">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[18px] font-bold text-sg-ink">座位設定</h1>
            <span className={`text-[12px] px-2 py-0.5 rounded-full font-bold ${layout?.status === 'published' ? 'bg-sg-sage-soft text-sg-sage-ink' : 'bg-sg-honey-soft text-sg-honey'}`}>
              {layout?.status === 'published' ? '已發布生效中' : '編輯草稿中'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
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
            發布版面
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        {message && (
          <div className={`p-3.5 rounded-2xl text-[13px] font-bold flex items-center justify-between ${
            message.type === 'success' ? 'bg-sg-sage-soft text-sg-sage-ink' : 'bg-sg-danger-soft text-sg-danger'
          }`}>
            <span>{message.text}</span>
            <button type="button" onClick={() => setMessage(null)} className="text-[12px] opacity-75">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div className="flex items-center justify-between">
          <SegmentedTabs
            tabs={[
              { id: 'editor', label: '座位編輯器', icon: <Layers className="w-4 h-4" /> },
              { id: 'rules', label: '排位規則與試算', icon: <Sliders className="w-4 h-4" /> }
            ]}
            activeId={activeTab}
            onChange={setActiveTab}
          />

          <div className="text-[12px] text-sg-muted">
            總座位數：<span className="font-bold text-sg-ink">{layout?.capacity || 16}</span> 席
          </div>
        </div>

        {activeTab === 'editor' && layout && (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 items-start">
            {/* Canvas Area */}
            <div className="lg:col-span-3 bg-white rounded-2xl border border-sg-line p-4 overflow-auto shadow-xs">
              <FloorPlan
                layout={layout}
                fitContainer={true}
                scale={0.85}
                interactive={true}
                onSeatClick={(seat) => {
                  setSelectedSeat(seat);
                  const t = layout.tables.find(tbl => tbl.id === seat.table_id);
                  setSelectedTable(t || null);
                }}
              />
            </div>

            {/* Sidebar properties panel */}
            <div className="bg-white rounded-2xl border border-sg-line p-4 space-y-4 shadow-xs">
              <h3 className="text-[15px] font-bold text-sg-ink pb-2 border-b border-sg-line">
                {selectedSeat ? `座位 ${selectedSeat.code}` : selectedTable ? `桌子 ${selectedTable.label}` : '點選座位或桌子'}
              </h3>

              {selectedSeat && (
                <div className="space-y-3 text-[13px]">
                  <div>
                    <label className="block text-sg-muted mb-1 font-medium">座位代號</label>
                    <input
                      type="text"
                      value={selectedSeat.code}
                      onChange={(e) => {
                        const newCode = e.target.value.trim().toUpperCase();
                        setLayout(prev => ({
                          ...prev,
                          seats: prev.seats.map(s => s.id === selectedSeat.id ? { ...s, code: newCode } : s)
                        }));
                        setSelectedSeat(prev => ({ ...prev, code: newCode }));
                      }}
                      className="w-full px-3 py-1.5 rounded-xl border border-sg-line font-bold"
                    />
                  </div>

                  <div>
                    <label className="block text-sg-muted mb-1 font-medium">排位優先序</label>
                    <select
                      value={selectedSeat.priority || 'normal'}
                      onChange={(e) => {
                        const pri = e.target.value;
                        setLayout(prev => ({
                          ...prev,
                          seats: prev.seats.map(s => s.id === selectedSeat.id ? { ...s, priority: pri } : s)
                        }));
                        setSelectedSeat(prev => ({ ...prev, priority: pri }));
                      }}
                      className="w-full px-3 py-1.5 rounded-xl border border-sg-line font-bold bg-white"
                    >
                      <option value="normal">一般座位</option>
                      <option value="second">第二順位</option>
                      <option value="last">冷氣出風口（最後排）</option>
                      <option value="manual_only">不自動排（現場手動帶位）</option>
                    </select>
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <span className="font-medium text-sg-ink">是否啟用</span>
                    <input
                      type="checkbox"
                      checked={selectedSeat.is_active}
                      onChange={(e) => {
                        const act = e.target.checked;
                        setLayout(prev => ({
                          ...prev,
                          seats: prev.seats.map(s => s.id === selectedSeat.id ? { ...s, is_active: act } : s)
                        }));
                        setSelectedSeat(prev => ({ ...prev, is_active: act }));
                      }}
                      className="w-4 h-4 rounded text-sg-brown focus:ring-sg-brown"
                    />
                  </div>
                </div>
              )}

              {selectedTable && !selectedSeat && (
                <div className="space-y-3 text-[13px]">
                  <div>
                    <label className="block text-sg-muted mb-1 font-medium">桌號名稱</label>
                    <input
                      type="text"
                      value={selectedTable.label}
                      onChange={(e) => {
                        const val = e.target.value;
                        setLayout(prev => ({
                          ...prev,
                          tables: prev.tables.map(t => t.id === selectedTable.id ? { ...t, label: val } : t)
                        }));
                        setSelectedTable(prev => ({ ...prev, label: val }));
                      }}
                      className="w-full px-3 py-1.5 rounded-xl border border-sg-line font-bold"
                    />
                  </div>

                  <div>
                    <label className="block text-sg-muted mb-1 font-medium">旋轉角度 (-180° ~ 180°)</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="-180"
                        max="180"
                        value={selectedTable.rotation || 0}
                        onChange={(e) => {
                          const rot = parseInt(e.target.value, 10);
                          setLayout(prev => ({
                            ...prev,
                            tables: prev.tables.map(t => t.id === selectedTable.id ? { ...t, rotation: rot } : t)
                          }));
                          setSelectedTable(prev => ({ ...prev, rotation: rot }));
                        }}
                        className="flex-1 accent-sg-brown"
                      />
                      <span className="w-12 text-right font-bold">{selectedTable.rotation || 0}°</span>
                    </div>
                  </div>
                </div>
              )}

              <div className="pt-4 border-t border-sg-line text-[12px] text-sg-muted space-y-2">
                <p>提示：點擊座位或桌子即可即時修改名稱、旋轉角度或優先序。</p>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'rules' && layout && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white rounded-2xl border border-sg-line p-5 space-y-4 shadow-xs">
              <h3 className="text-[16px] font-bold text-sg-ink pb-2 border-b border-sg-line">
                排位演算法偏好
              </h3>

              <div className="space-y-3">
                <label className="flex items-start gap-3 p-3 rounded-xl border border-sg-line hover:bg-sg-paper cursor-pointer transition">
                  <input
                    type="checkbox"
                    checked={layout.rules_json?.spread_tables ?? true}
                    onChange={(e) => updateRules('spread_tables', e.target.checked)}
                    className="mt-1 w-4 h-4 rounded text-sg-brown focus:ring-sg-brown"
                  />
                  <div>
                    <span className="text-[13px] font-bold text-sg-ink block">左右交錯分桌排位</span>
                    <span className="text-[12px] text-sg-muted mt-0.5 block">
                      小組先坐空桌的一側，桌子之間左右交錯（桌 1 左、桌 2 右、桌 3 左）。
                    </span>
                  </div>
                </label>

                <label className="flex items-start gap-3 p-3 rounded-xl border border-sg-line hover:bg-sg-paper cursor-pointer transition">
                  <input
                    type="checkbox"
                    checked={layout.rules_json?.avoid_opposite ?? true}
                    onChange={(e) => updateRules('avoid_opposite', e.target.checked)}
                    className="mt-1 w-4 h-4 rounded text-sg-brown focus:ring-sg-brown"
                  />
                  <div>
                    <span className="text-[13px] font-bold text-sg-ink block">避開對面有人的位置</span>
                    <span className="text-[12px] text-sg-muted mt-0.5 block">
                      每張桌都有人之後，才排對面有人的位置。
                    </span>
                  </div>
                </label>

                <label className="flex items-start gap-3 p-3 rounded-xl border border-sg-line hover:bg-sg-paper cursor-pointer transition">
                  <input
                    type="checkbox"
                    checked={layout.rules_json?.avoid_beside ?? true}
                    onChange={(e) => updateRules('avoid_beside', e.target.checked)}
                    className="mt-1 w-4 h-4 rounded text-sg-brown focus:ring-sg-brown"
                  />
                  <div>
                    <span className="text-[13px] font-bold text-sg-ink block">避開隔壁相鄰位置</span>
                    <span className="text-[12px] text-sg-muted mt-0.5 block">
                      相鄰座位盡量留空，保障顧客創作隱私空間。
                    </span>
                  </div>
                </label>
              </div>
            </div>

            {/* Live preview test stepper */}
            <div className="bg-white rounded-2xl border border-sg-line p-5 space-y-4 shadow-xs">
              <h3 className="text-[16px] font-bold text-sg-ink pb-2 border-b border-sg-line">
                排位演算法即時試算
              </h3>

              <div className="flex items-center gap-3">
                <span className="text-[13px] font-bold text-sg-ink">預約人數：</span>
                <div className="flex items-center gap-1.5">
                  {[1, 2, 3, 4, 6].map(num => (
                    <button
                      key={num}
                      type="button"
                      onClick={() => setTestPax(num)}
                      className={`min-h-[36px] px-3 rounded-xl text-[13px] font-bold border transition ${
                        testPax === num ? 'bg-sg-brown text-white border-sg-brown' : 'bg-sg-paper text-sg-ink border-sg-line'
                      }`}
                    >
                      {num} 人
                    </button>
                  ))}
                </div>
              </div>

              <Button
                variant="primary"
                size="sm"
                onClick={handleRunAllocTest}
                loading={testing}
              >
                試算最佳座位
              </Button>

              {testResult && (
                <div className="p-3.5 rounded-xl bg-sg-paper border border-sg-line space-y-1.5 text-[13px]">
                  {testResult.error ? (
                    <div className="text-sg-danger font-bold flex items-center gap-1.5">
                      <AlertCircle className="w-4 h-4" />
                      {testResult.error}
                    </div>
                  ) : (
                    <>
                      <div className="font-bold text-sg-ink">
                        建議排位結果：<span className="text-sg-brown text-[15px]">{testResult.seats?.join('、')}</span>
                      </div>
                      <div className="text-sg-muted text-[12px]">
                        計分：{testResult.score} 分 · 原因：{testResult.reason || '最佳得分組合'}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Publish Confirm Modal */}
      <ConfirmPanel
        isOpen={showPublishConfirm}
        onClose={() => setShowPublishConfirm(false)}
        onConfirm={handleConfirmPublish}
        title="確認發布座位版面"
        confirmText="確認發布並同步時段上限"
        loading={saving}
      >
        <div className="space-y-3 text-[13px] text-sg-ink py-2">
          <p>生效日期（台北時間）：</p>
          <input
            type="date"
            value={publishDate}
            onChange={(e) => setPublishDate(e.target.value)}
            className="w-full px-3 py-2 rounded-xl border border-sg-line font-bold"
          />

          {previewPublishData && (
            <div className="p-3 rounded-xl bg-sg-paper border border-sg-line space-y-1.5 text-[12px]">
              <div>時段人數上限調整：<span className="font-bold">{previewPublishData.capacity_before || 20} 人 → {previewPublishData.capacity_after || 16} 人</span></div>
              {previewPublishData.affected_bookings?.length > 0 && (
                <div className="text-sg-danger font-bold">
                  有 {previewPublishData.affected_bookings.length} 筆未來預約將自動重新排位！
                </div>
              )}
            </div>
          )}
        </div>
      </ConfirmPanel>
    </div>
  );
}
