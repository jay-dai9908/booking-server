import React, { useState, useEffect } from 'react';
import { Ticket, Check, AlertCircle } from 'lucide-react';
import api from '../../../api/axios';
import ResponsivePanel from '../ResponsivePanel';
import Button from '../../customer/Button';

export default function PassTenderSheet({
  isOpen = false,
  onClose,
  bookingRef,
  personNo,
  onSelectPass, // (passTender: { user_pass_id, person_no, units }) => void
  hourlyRate = 150
}) {
  const [passes, setPasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedPassId, setSelectedPassId] = useState(null);
  const [units, setUnits] = useState(1);

  useEffect(() => {
    if (!isOpen || !bookingRef) return;
    fetchPasses();
  }, [isOpen, bookingRef]);

  const fetchPasses = async () => {
    try {
      setLoading(true);
      const res = await api.get(`/billing/${bookingRef}/passes`);
      const list = res.data?.passes || [];
      setPasses(list);
      // Auto select first usable pass
      const firstUsable = list.find(p => p.usable);
      if (firstUsable) {
        setSelectedPassId(firstUsable.id);
        const suggest = firstUsable.suggest?.find(s => s.person_no === personNo);
        setUnits(suggest?.units || 1);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = () => {
    if (!selectedPassId) return;
    onSelectPass({
      user_pass_id: selectedPassId,
      person_no: personNo,
      units
    });
    onClose();
  };

  const selectedPass = passes.find(p => p.id === selectedPassId);

  return (
    <ResponsivePanel
      isOpen={isOpen}
      onClose={onClose}
      title={`第 ${personNo} 位 · 選擇卡券折抵`}
      subtitle="僅能使用此預約會員本人之有效卡券"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleConfirm}
            disabled={!selectedPass || !selectedPass.usable}
          >
            確認套用折抵
          </Button>
        </div>
      }
    >
      <div className="space-y-3 py-2">
        {loading ? (
          <div className="text-center py-8 text-sg-muted text-[13px]">載入卡券中...</div>
        ) : passes.length === 0 ? (
          <div className="text-center py-8 text-sg-muted text-[13px]">
            此會員目前沒有任何卡券
          </div>
        ) : (
          passes.map((pass) => {
            const isSelected = selectedPassId === pass.id;
            const isUsable = pass.usable;

            return (
              <div
                key={pass.id}
                onClick={isUsable ? () => {
                  setSelectedPassId(pass.id);
                  const sug = pass.suggest?.find(s => s.person_no === personNo);
                  if (sug) setUnits(sug.units || 1);
                } : undefined}
                className={`p-3.5 rounded-2xl border transition select-none ${
                  !isUsable
                    ? 'bg-sg-paper/60 border-sg-line/60 opacity-60 cursor-not-allowed'
                    : isSelected
                    ? 'bg-sg-brown-soft border-sg-brown shadow-xs cursor-pointer'
                    : 'bg-white border-sg-line hover:border-sg-muted cursor-pointer'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <Ticket className={`w-4 h-4 ${isSelected ? 'text-sg-brown' : 'text-sg-muted'}`} />
                    <span className="text-[14px] font-bold text-sg-ink">{pass.plan_name}</span>
                  </div>
                  {isSelected && <Check className="w-4 h-4 text-sg-brown" />}
                </div>

                <div className="mt-2 flex items-center justify-between text-[12px] text-sg-muted">
                  <span>
                    剩餘額度：<span className="font-bold text-sg-ink">{pass.remaining_quota ?? '無限制'}</span> {pass.pass_type === 'TIME_PASS' ? '小時' : '次'}
                  </span>
                  {pass.expires_at && (
                    <span>到期日：{pass.expires_at.slice(0, 10)}</span>
                  )}
                </div>

                {!isUsable && pass.reason && (
                  <div className="mt-2 text-[11px] font-bold text-sg-danger flex items-center gap-1">
                    <AlertCircle className="w-3.5 h-3.5" />
                    {pass.reason}
                  </div>
                )}

                {isSelected && isUsable && pass.pass_type === 'TIME_PASS' && (
                  <div className="mt-3 pt-3 border-t border-sg-line flex items-center justify-between">
                    <span className="text-[12px] font-medium text-sg-ink">使用時數</span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setUnits(Math.max(1, units - 1)); }}
                        className="w-7 h-7 rounded-lg border border-sg-line text-[14px] font-bold flex items-center justify-center bg-white"
                      >
                        −
                      </button>
                      <span className="font-bold text-[14px] min-w-[24px] text-center">{units}</span>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setUnits(Math.min(pass.remaining_quota || 99, units + 1)); }}
                        className="w-7 h-7 rounded-lg border border-sg-line text-[14px] font-bold flex items-center justify-center bg-white"
                      >
                        +
                      </button>
                      <span className="text-[12px] text-sg-muted">小時</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </ResponsivePanel>
  );
}
