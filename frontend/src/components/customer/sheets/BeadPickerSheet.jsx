import React, { useState, useMemo } from 'react';
import { Search } from 'lucide-react';
import BottomSheet from '../BottomSheet';
import Button from '../Button';
import Pill from '../Pill';
import Stepper from '../Stepper';
import { SoftBox } from '../Banners';
import { useToast } from '../Toast';
import {
  MARD_SERIES_INFO,
  DEFAULT_MARD_COLORS,
  getBeadSwatchStyle,
  calculateBeadsSubtotalWithMode,
} from '../../../utils/mardBeadColors';
import { formatMoneyBig, formatMoney } from '../../../utils/customer/format';

/**
 * BeadPickerSheet (Section 6.18)
 * Tall modal sheet for picking individual MARD bead color codes, series tabs, tier discounts.
 */
export default function BeadPickerSheet({
  isOpen,
  onClose,
  product,
  selectedColors = {}, // { [code]: quantity }
  onChangeColors,
  allColors = DEFAULT_MARD_COLORS,
}) {
  const toast = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSeries, setActiveSeries] = useState(MARD_SERIES_INFO[0].id);
  const [activeColorCode, setActiveColorCode] = useState(null);

  // Available series tabs (removing emoji and standardising labels as per Section 6.18)
  const seriesTabs = useMemo(() => {
    return MARD_SERIES_INFO.map((s) => {
      let displayLabel = s.name;
      if (s.group === 'special') {
        displayLabel = (s.shortLabel || s.name).replace(/^[A-Za-z]\s*/, '').trim();
      }
      return {
        id: s.id,
        label: displayLabel,
      };
    });
  }, []);

  // Filtered colors
  const filteredColors = useMemo(() => {
    const q = searchQuery.trim().toUpperCase();
    if (q) {
      return allColors.filter(
        (c) => c.code.toUpperCase().includes(q) || (c.name && c.name.toUpperCase().includes(q))
      );
    }
    return allColors.filter((c) => c.series === activeSeries);
  }, [allColors, searchQuery, activeSeries]);

  // Selected stats
  const totalColorsCount = useMemo(() => {
    return Object.values(selectedColors).filter((q) => Number(q) > 0).length;
  }, [selectedColors]);

  const totalBagsCount = useMemo(() => {
    return Object.values(selectedColors).reduce((acc, q) => acc + (Number(q) || 0), 0);
  }, [selectedColors]);

  // Price calculation
  const subtotal = useMemo(() => {
    return calculateBeadsSubtotalWithMode(product, totalBagsCount, selectedColors);
  }, [product, totalBagsCount, selectedColors]);

  // Tier pricing explanation text (Section 6.18)
  const tierPricingText = useMemo(() => {
    if (!product?.tier_pricing || product.tier_pricing.length === 0) return null;
    const sorted = [...product.tier_pricing].sort((a, b) => a.qty - b.qty);
    const parts = sorted.map((t) => `${t.qty} 包 ${formatMoney(t.price)}`).join('、');
    const suffix =
      product.tier_discount_mode === 'combined'
        ? '，不同色號可以合併計算'
        : '，每個色號各自計算';
    return parts + suffix;
  }, [product]);

  // Handle color click
  const handleColorClick = (color) => {
    if (color.is_available === false) {
      toast.show(`${color.code} 目前缺貨`, { type: 'info' });
      return;
    }
    const curQty = selectedColors[color.code] || 0;
    const newQty = curQty + 1;
    onChangeColors({
      ...selectedColors,
      [color.code]: newQty,
    });
    setActiveColorCode(color.code);
  };

  const handleQtyChange = (code, qty) => {
    const updated = { ...selectedColors };
    if (qty <= 0) {
      delete updated[code];
      if (activeColorCode === code) {
        setActiveColorCode(null);
      }
    } else {
      updated[code] = qty;
    }
    onChangeColors(updated);
  };

  const handleClearAll = () => {
    onChangeColors({});
    setActiveColorCode(null);
  };

  const handleClose = () => {
    setActiveColorCode(null);
    onClose?.();
  };

  React.useEffect(() => {
    if (!isOpen) {
      setActiveColorCode(null);
    }
  }, [isOpen]);

  // Selected colors list entries
  const selectedColorEntries = useMemo(() => {
    return Object.entries(selectedColors)
      .filter(([_, q]) => Number(q) > 0)
      .map(([code, qty]) => {
        const color = allColors.find((c) => c.code === code) || { code, hex: '#CCCCCC' };
        return { color, code, qty: Number(qty) };
      });
  }, [selectedColors, allColors]);

  // Header subtitle
  const subtitle = product?.description
    ? product.description.split('\n')[0]
    : '每包 10g，約 1,000 顆';

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={handleClose}
      size="tall"
      title="選擇融合豆色號"
      headerRight={
        totalColorsCount > 0 && (
          <Button
            variant="text"
            size="sm"
            onClick={handleClearAll}
            className="text-[13px] text-sg-muted hover:text-sg-ink"
          >
            清除
          </Button>
        )
      }
    >
      <div className="flex flex-col h-full min-h-0 min-w-0">
        <div className="sg-small -mt-3 mb-2">{subtitle}</div>

        {/* Search bar */}
        <div className="flex items-center gap-2 rounded-[12px] border-[1.5px] border-sg-line bg-sg-paper px-[10px] py-[7px] mb-2 shrink-0">
          <Search className="w-4 h-4 text-sg-muted shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜尋色號，例如 A12"
            className="w-full bg-transparent text-[16px] text-sg-ink placeholder:text-sg-full focus:outline-none"
          />
        </div>

        {/* Series horizontal strip (hidden when searching) */}
        {!searchQuery && (
          <div className="flex gap-[6px] overflow-x-auto pb-2 shrink-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(90deg,#000_88%,transparent)]">
            {seriesTabs.map((s) => {
              const isSelected = activeSeries === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setActiveSeries(s.id)}
                  aria-pressed={isSelected}
                  className={`flex-none px-3 py-1.5 rounded-full text-[12px] font-bold transition min-h-[36px] ${
                    isSelected
                      ? 'bg-sg-brown text-white'
                      : 'bg-sg-paper border border-sg-line text-sg-muted'
                  }`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Colors grid (scrollable area) */}
        <div className="flex-1 overflow-y-auto min-h-0 py-2">
          {filteredColors.length === 0 ? (
            <div className="py-8 text-center text-sg-muted text-[13px]">
              找不到符合的色號
            </div>
          ) : (
            <div className="grid grid-cols-6 gap-x-1 gap-y-[10px]">
              {filteredColors.map((c) => {
                const qty = selectedColors[c.code] || 0;
                const isAvail = c.is_available !== false;
                const isSelected = qty > 0;
                const swatch = getBeadSwatchStyle(c);
                const isWhite = c.hex?.toLowerCase() === '#ffffff' || c.hex?.toLowerCase() === '#fff';

                return (
                  <button
                    key={c.code}
                    type="button"
                    onClick={() => handleColorClick(c)}
                    aria-label={`色號 ${c.code}${qty > 0 ? `，已選 ${qty} 包` : ''}`}
                    aria-disabled={!isAvail}
                    className={`relative grid justify-items-center gap-[2px] font-num font-bold text-[12px] p-1 transition ${
                      !isAvail ? 'opacity-[.35]' : 'active:scale-95'
                    }`}
                  >
                    {/* Bead visual representation (26px circle with 10px inner hole) */}
                    <div
                      className="relative w-[26px] h-[26px] rounded-full grid place-items-center transition"
                      style={{
                        ...swatch,
                        boxShadow: isSelected
                          ? '0 0 0 2px #FFFDF9, 0 0 0 4px #8B5B43'
                          : isWhite
                          ? 'inset 0 0 0 1px #E6DDD2'
                          : undefined,
                      }}
                    >
                      <div className="w-[10px] h-[10px] rounded-full bg-sg-paper" />
                    </div>

                    {/* Quantity badge */}
                    {qty > 0 && (
                      <span className="absolute -top-[2px] right-0 min-w-[16px] h-4 px-1 rounded-full bg-sg-brown text-white text-[12px] leading-4 text-center font-num">
                        {qty}
                      </span>
                    )}

                    <span className={isSelected ? 'text-sg-brown font-extrabold' : 'text-sg-muted'}>
                      {c.code}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Selected colors list / active adjustment area */}
        {selectedColorEntries.length > 0 && (
          <div className="flex flex-col gap-1.5 max-h-[160px] overflow-y-auto mt-2 shrink-0 pr-1">
            {selectedColorEntries.map(({ color, code, qty }) => {
              const isAdjusting = activeColorCode === code;
              return (
                <div
                  key={code}
                  data-testid={`bead-row-${code}`}
                  onClick={() => setActiveColorCode(code)}
                  className={`flex items-center justify-between rounded-[12px] px-3 py-2 cursor-pointer transition ${
                    isAdjusting
                      ? 'bg-sg-brown-soft/40 border border-sg-brown/30'
                      : 'bg-sg-bg border border-transparent hover:bg-sg-bg/80'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className="w-[18px] h-[18px] rounded-full grid place-items-center border border-sg-line shrink-0"
                      style={getBeadSwatchStyle(color)}
                    >
                      <div className="w-[6px] h-[6px] rounded-full bg-sg-paper" />
                    </div>
                    <span className="font-bold text-[14px] text-sg-ink font-num">
                      {code}
                    </span>
                    <span className="sg-small">
                      {qty} 包
                    </span>
                    {isAdjusting && (
                      <span className="text-[11px] text-sg-brown font-bold bg-sg-brown-soft px-1.5 py-0.5 rounded shrink-0">
                        目前調整中
                      </span>
                    )}
                  </div>

                  <div onClick={(e) => e.stopPropagation()}>
                    <Stepper
                      value={qty}
                      min={0}
                      max={999}
                      onMinus={() => {
                        setActiveColorCode(code);
                        handleQtyChange(code, qty - 1);
                      }}
                      onPlus={() => {
                        setActiveColorCode(code);
                        handleQtyChange(code, qty + 1);
                      }}
                      label={`調整 ${code} 數量`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Tier pricing explanation */}
        {tierPricingText && (
          <SoftBox className="mt-2 shrink-0">
            {tierPricingText}
          </SoftBox>
        )}

        {/* Sticky bottom bar */}
        <div className="flex items-center gap-[10px] pt-3 mt-2 border-t border-sg-line bg-sg-paper shrink-0">
          <div className="flex-1 min-w-0">
            <div className="sg-small">
              已選 {totalColorsCount} 色 · {totalBagsCount} 包
            </div>
            <div className="font-num font-extrabold text-[20px] leading-[1.1] text-sg-brown">
              {formatMoneyBig(subtotal)}
            </div>
          </div>

          <Button
            variant="primary"
            size="sm"
            onClick={handleClose}
            className="min-h-[44px] px-[22px]"
          >
            完成
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}
