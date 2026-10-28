import React, { useState } from 'react';
import { X, Copy, Check, ShieldCheck, ScanLine } from 'lucide-react';
import { generateCode128Svg } from '../utils/barcodeHelper';

export default function BarcodeModal({
  isOpen,
  onClose,
  code,
  title = '到店掃碼進店憑證',
  subtitle = '請出示此條碼給門市櫃檯人員掃描核銷',
  details = []
}) {
  const [copied, setCopied] = useState(false);

  if (!isOpen || !code) return null;

  const handleCopy = () => {
    navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const barcodeSvg = generateCode128Svg(code, 80);

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs animate-fade-in">
      <div className="bg-white rounded-3xl shadow-2xl border border-[#E8DEC8] w-full max-w-md overflow-hidden flex flex-col animate-zoom-in">
        {/* Header */}
        <div className="bg-[#3E332B] text-white px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[#8B5B43] flex items-center justify-center text-white">
              <ScanLine className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-extrabold text-base tracking-tight">{title}</h3>
              <p className="text-[11px] text-[#D5CFC9]">{subtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* High contrast barcode card */}
        <div className="p-6 bg-linear-to-b from-white to-[#FAF7F2] flex flex-col items-center">
          <div className="w-full bg-white p-5 rounded-2xl border-2 border-[#1A1512] shadow-md flex flex-col items-center text-center">
            {/* Standard Code-128B Barcode */}
            <div className="w-full max-w-[360px] px-2 py-3 bg-white rounded-xl">
              <div
                dangerouslySetInnerHTML={{ __html: barcodeSvg }}
                className="w-full flex justify-center"
              />
            </div>

            {/* Code Text with Copy */}
            <div className="mt-3 flex items-center gap-2">
              <span className="font-mono font-black text-lg sm:text-xl tracking-widest text-[#1A1512]">
                {code}
              </span>
              <button
                type="button"
                onClick={handleCopy}
                className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-500 hover:text-slate-700 transition"
                title="複製編號"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
            <div className="text-[11px] text-[#8C8279] mt-0.5 font-medium">
              標準 Code-128B 條碼 · 支援門市雷射與光學掃描槍
            </div>
          </div>

          {/* Details Table */}
          {details.length > 0 && (
            <div className="w-full mt-4 bg-white rounded-2xl p-4 border border-[#E8DEC8] space-y-2 text-xs">
              {details.map((item, idx) => (
                <div key={idx} className="flex justify-between items-center py-0.5">
                  <span className="text-[#8C8279] font-medium">{item.label}</span>
                  <span className={`font-bold ${item.color || 'text-[#3E332B]'}`}>{item.value}</span>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 flex items-center gap-1.5 text-xs text-[#8C8279]">
            <ShieldCheck className="w-4 h-4 text-emerald-600" />
            <span>到店請調高手機螢幕亮度以利櫃檯設備快速掃碼</span>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-[#FAF7F2] border-t border-[#E8DEC8] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="w-full sm:w-auto px-6 py-2.5 bg-[#8B5B43] hover:bg-[#7A4F3A] text-white rounded-xl font-bold text-sm transition shadow-xs"
          >
            關閉憑證
          </button>
        </div>
      </div>
    </div>
  );
}
