import React, { useState, useEffect } from 'react';
import {
  X,
  Send,
  MessageCircle,
  Sparkles,
  Clock,
  Palette,
  CreditCard,
  User,
  AlertTriangle,
  CheckCircle2,
  ExternalLink
} from 'lucide-react';
import api from '../api/axios';
import { format } from 'date-fns';

export default function SendLineMessageModal({
  isOpen,
  onClose,
  user,
  reservation = null
}) {
  const [messageType, setMessageType] = useState('flex'); // 'flex' | 'text'
  const [activeTemplate, setActiveTemplate] = useState('retain'); // 'retain' | 'artwork' | 'payment' | 'custom'
  const [title, setTitle] = useState('預約時段保留提醒');
  const [content, setContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null); // { type: 'success' | 'error', text: string }

  // Extract reservation details if provided
  const rawDate = reservation?.session_date || reservation?.session?.session_date;
  const dateStr = rawDate ? format(new Date(rawDate), 'yyyy/MM/dd') : '今日';
  const timeRange =
    reservation?.time_range ||
    (reservation?.session ? `${reservation.session.start_time} - ${reservation.session.end_time}` : '');
  const shortRef = reservation?.booking_ref
    ? `#${String(reservation.booking_ref).slice(0, 8).toUpperCase()}`
    : '';

  const userName = user?.name || user?.line_display_name || '顧客';

  // Apply template helper
  const applyTemplate = (tmplKey) => {
    setActiveTemplate(tmplKey);
    setStatusMsg(null);

    if (tmplKey === 'retain') {
      setTitle('預約時段保留提醒');
      setContent(
        `親愛的 ${userName} 您好，提醒您於 ${dateStr} ${timeRange ? timeRange + ' ' : ''}預約了【拾光製所】手作體驗！名額將為您保留 15 分鐘，若會晚到或需調整行程請隨時告訴我們喔✨`
      );
    } else if (tmplKey === 'artwork') {
      setTitle('手作作品溫馨通知');
      setContent(
        `親愛的 ${userName} 您好，您於【拾光製所】製作的拼豆作品我們已為您妥善收好，歡迎於營業時間內前來門市領取！`
      );
    } else if (tmplKey === 'payment') {
      setTitle('訂單款項確認提醒');
      setContent(
        `親愛的 ${userName} 您好，與您確認預約單號 ${shortRef || '手作體驗'} 之款項事宜，如有任何問題歡迎直接於官方帳號回覆我們，謝謝您！`
      );
    } else if (tmplKey === 'custom') {
      setTitle('拾光製所 專屬關懷');
      setContent('');
    }
  };

  useEffect(() => {
    if (isOpen && user) {
      applyTemplate(reservation ? 'retain' : 'custom');
      setStatusMsg(null);
    }
  }, [isOpen, user, reservation]);

  if (!isOpen || !user) return null;

  const isManual = !user.line_user_id || user.line_user_id.startsWith('manual_');

  const handleSend = async (e) => {
    e.preventDefault();
    if (!content.trim()) {
      setStatusMsg({ type: 'error', text: '請輸入欲發送的訊息內容' });
      return;
    }
    if (isManual) {
      setStatusMsg({ type: 'error', text: '此會員為櫃檯手動建檔，尚未綁定真實 LINE 帳號，無法發送 LINE 訊息' });
      return;
    }

    setIsSubmitting(true);
    setStatusMsg(null);

    try {
      const payload = {
        message_type: messageType,
        title: title.trim(),
        content: content.trim(),
        booking_info: reservation
          ? {
              booking_ref: reservation.booking_ref,
              session_date: dateStr,
              time_range: timeRange
            }
          : null
      };

      const res = await api.post(`/users/${user.id}/line-message`, payload);
      setStatusMsg({
        type: 'success',
        text: res.data?.message || 'LINE 訊息已成功推播至顧客手機！'
      });

      // Auto close on success after a short delay
      setTimeout(() => {
        onClose();
      }, 1800);
    } catch (err) {
      console.error('Send LINE message failed:', err);
      setStatusMsg({
        type: 'error',
        text: err.response?.data?.error || err.message || '發送失敗，請檢查網路連線或 LINE 設定'
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-xs animate-fade-in">
      <div className="bg-white rounded-2xl sm:rounded-3xl shadow-2xl border border-[#E8DEC8] w-full max-w-2xl overflow-hidden flex flex-col max-h-[92vh] animate-zoom-in">
        {/* Header */}
        <div className="px-5 py-3.5 sm:px-6 sm:py-4 bg-[#3E332B] text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[#06C755] flex items-center justify-center text-white shadow-xs">
              <MessageCircle className="w-5 h-5 fill-current" />
            </div>
            <div>
              <h3 className="font-extrabold text-base sm:text-lg tracking-tight">
                發送 LINE 官方帳號訊息
              </h3>
              <p className="text-[11px] text-[#D5CFC9]">
                一對一推播專屬提醒至顧客 LINE 聊天室
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center text-lg font-bold transition"
            aria-label="關閉"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Recipient Profile Banner */}
        <div className="bg-[#FAF7F2] px-5 py-3 border-b border-[#E8DEC8] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {user.line_picture_url ? (
              <img
                src={user.line_picture_url}
                alt={user.name || 'avatar'}
                className="w-10 h-10 rounded-full object-cover border border-[#06C755]/40 shrink-0"
              />
            ) : (
              <div className="w-10 h-10 rounded-full bg-white border border-[#E8DEC8] text-[#8B5B43] font-black text-sm flex items-center justify-center shrink-0">
                {user.name ? user.name.slice(0, 1) : <User className="w-5 h-5" />}
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-[#3E332B] text-sm truncate">
                  {user.name || '未填寫姓名'}
                </span>
                {user.line_display_name && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#06C755]/15 text-[#059941] border border-[#06C755]/30">
                    LINE: {user.line_display_name}
                  </span>
                )}
                {isManual && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300">
                    ⚠️ 尚未綁定 LINE
                  </span>
                )}
              </div>
              <p className="text-xs text-[#8C8279] mt-0.5 truncate">
                手機：{user.phone || '未提供'}
                {reservation && (
                  <span className="ml-2 text-[#8B5B43] font-semibold">
                    · 單號 {shortRef} ({dateStr} {timeRange})
                  </span>
                )}
              </p>
            </div>
          </div>
        </div>

        {/* Modal Scrollable Body */}
        <div className="p-5 sm:p-6 overflow-y-auto space-y-5 flex-1">
          {isManual && (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3 text-xs text-amber-900">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <strong className="block text-sm font-bold mb-0.5">無法推播 LINE 訊息</strong>
                此會員為現場櫃檯建檔客人（尚未透過 LINE 登入進行手機號碼綁定）。需等該顧客日後透過 LINE 官方預約系統登入並填寫相同電話號碼後，系統才會自動綁定並啟用發訊。
              </div>
            </div>
          )}

          {/* Quick Template Capsules */}
          <div>
            <label className="block text-xs font-bold text-[#6D5D52] mb-2 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-[#8B5B43]" />
              門市常用快捷範本（點擊即自動帶入文字，可自由編輯）：
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <button
                type="button"
                onClick={() => applyTemplate('retain')}
                className={`px-3 py-2 rounded-xl text-xs font-bold border transition text-left flex items-center gap-1.5 ${
                  activeTemplate === 'retain'
                    ? 'bg-[#8B5B43] text-white border-[#8B5B43] shadow-xs'
                    : 'bg-[#FAF7F2] text-[#3E332B] border-[#E8DEC8] hover:bg-[#F2ECE4]'
                }`}
              >
                <Clock className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">⏰ 座位保留提醒</span>
              </button>

              <button
                type="button"
                onClick={() => applyTemplate('artwork')}
                className={`px-3 py-2 rounded-xl text-xs font-bold border transition text-left flex items-center gap-1.5 ${
                  activeTemplate === 'artwork'
                    ? 'bg-[#8B5B43] text-white border-[#8B5B43] shadow-xs'
                    : 'bg-[#FAF7F2] text-[#3E332B] border-[#E8DEC8] hover:bg-[#F2ECE4]'
                }`}
              >
                <Palette className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">🎨 作品取件通知</span>
              </button>

              <button
                type="button"
                onClick={() => applyTemplate('payment')}
                className={`px-3 py-2 rounded-xl text-xs font-bold border transition text-left flex items-center gap-1.5 ${
                  activeTemplate === 'payment'
                    ? 'bg-[#8B5B43] text-white border-[#8B5B43] shadow-xs'
                    : 'bg-[#FAF7F2] text-[#3E332B] border-[#E8DEC8] hover:bg-[#F2ECE4]'
                }`}
              >
                <CreditCard className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">💳 款項確認提醒</span>
              </button>

              <button
                type="button"
                onClick={() => applyTemplate('custom')}
                className={`px-3 py-2 rounded-xl text-xs font-bold border transition text-left flex items-center gap-1.5 ${
                  activeTemplate === 'custom'
                    ? 'bg-[#8B5B43] text-white border-[#8B5B43] shadow-xs'
                    : 'bg-[#FAF7F2] text-[#3E332B] border-[#E8DEC8] hover:bg-[#F2ECE4]'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">✨ 專屬自由輸入</span>
              </button>
            </div>
          </div>

          {/* Format Selector: Flex Card vs Plain Text */}
          <div className="flex items-center justify-between gap-3 p-3 bg-[#FAF7F2] rounded-2xl border border-[#E8DEC8]">
            <span className="text-xs font-bold text-[#3E332B]">推播訊息呈現格式：</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setMessageType('flex')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition ${
                  messageType === 'flex'
                    ? 'bg-[#8B5B43] text-white border-[#8B5B43] shadow-xs'
                    : 'bg-white text-[#6D5D52] border-[#E8DEC8] hover:bg-[#F2ECE4]'
                }`}
              >
                📇 拾光品牌通知卡 (Flex)
              </button>
              <button
                type="button"
                onClick={() => setMessageType('text')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition ${
                  messageType === 'text'
                    ? 'bg-[#8B5B43] text-white border-[#8B5B43] shadow-xs'
                    : 'bg-white text-[#6D5D52] border-[#E8DEC8] hover:bg-[#F2ECE4]'
                }`}
              >
                💬 一般純文字訊息
              </button>
            </div>
          </div>

          {/* Input Fields */}
          <div className="space-y-3">
            {messageType === 'flex' && (
              <div>
                <label className="block text-xs font-bold text-[#3E332B] mb-1">
                  通知卡片主標題
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="例如：預約時段保留提醒"
                  className="w-full px-3.5 py-2 text-xs sm:text-sm font-bold bg-white border border-[#E8DEC8] rounded-xl text-[#3E332B] focus:border-[#8B5B43] outline-none"
                />
              </div>
            )}

            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="block text-xs font-bold text-[#3E332B]">
                  訊息本文內容 <span className="text-rose-500">*</span>
                </label>
                <span className="text-[11px] text-[#8C8279]">
                  {content.length} 字
                </span>
              </div>
              <textarea
                rows={4}
                required
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="輸入欲發送給顧客的完整訊息..."
                className="w-full px-3.5 py-2.5 text-xs sm:text-sm bg-white border border-[#E8DEC8] rounded-xl text-[#3E332B] focus:border-[#8B5B43] outline-none leading-relaxed"
              />
            </div>
          </div>

          {/* Real-time Preview Area */}
          <div className="border border-dashed border-[#E8DEC8] rounded-2xl p-4 bg-[#FAF8F5]">
            <span className="text-[11px] font-bold text-[#8C8279] uppercase tracking-wider block mb-2">
              📱 顧客手機 LINE 預覽模擬效果：
            </span>

            {messageType === 'flex' ? (
              /* Simulated Flex Bubble Card */
              <div className="max-w-sm mx-auto bg-white rounded-2xl shadow-md border border-[#E8DEC8] overflow-hidden">
                <div className="bg-[#8B5B43] text-white p-4">
                  <div className="flex justify-between items-center text-[10px] tracking-widest text-[#FAF7F2] font-bold">
                    <span>拾光製所 SHIGUANG</span>
                    <span className="bg-white/20 px-1.5 py-0.5 rounded text-[9px]">門市通知</span>
                  </div>
                  <h4 className="text-base font-extrabold mt-1 text-white">
                    {title || '拾光製所 專屬通知'}
                  </h4>
                  <p className="text-[11px] text-[#E8DEC8] mt-0.5">
                    發送對象：{userName}
                  </p>
                </div>

                <div className="p-4 bg-[#FAF7F2] space-y-3">
                  <p className="text-xs text-[#3E332B] leading-relaxed whitespace-pre-wrap font-medium">
                    {content || '(尚未輸入內文)'}
                  </p>

                  {reservation && (
                    <div className="bg-white p-3 rounded-xl border border-[#E8DEC8] text-xs space-y-1">
                      <div className="flex justify-between text-[#8C8279]">
                        <span>相關預約：</span>
                        <strong className="text-[#3E332B]">{shortRef}</strong>
                      </div>
                      <div className="flex justify-between text-[#8C8279]">
                        <span>預約日期：</span>
                        <strong className="text-[#3E332B]">{dateStr}</strong>
                      </div>
                      <div className="flex justify-between text-[#8C8279]">
                        <span>預約時段：</span>
                        <strong className="text-[#3E332B]">{timeRange || '已排定'}</strong>
                      </div>
                    </div>
                  )}

                  <div className="pt-1">
                    <div className="w-full py-2 bg-[#8B5B43] text-white text-center rounded-xl font-bold text-xs shadow-2xs">
                      開啟拾光製所預約系統 ↗
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              /* Simulated Plain Text Chat Bubble */
              <div className="max-w-sm mx-auto flex items-start gap-2.5">
                <div className="w-8 h-8 rounded-full bg-[#3E332B] text-white flex items-center justify-center text-xs font-bold shrink-0">
                  拾光
                </div>
                <div className="bg-white border border-[#E8DEC8] p-3 rounded-2xl rounded-tl-xs shadow-xs text-xs text-[#3E332B] leading-relaxed whitespace-pre-wrap font-medium">
                  {content || '(尚未輸入訊息內容)'}
                </div>
              </div>
            )}
          </div>

          {/* Status Alert */}
          {statusMsg && (
            <div
              className={`p-3.5 rounded-xl border text-xs font-bold flex items-center gap-2 ${
                statusMsg.type === 'success'
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                  : 'bg-rose-50 text-rose-800 border-rose-300'
              }`}
            >
              {statusMsg.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
              ) : (
                <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600" />
              )}
              <span>{statusMsg.text}</span>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3.5 sm:px-6 bg-white border-t border-[#E8DEC8] flex items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 text-xs sm:text-sm font-bold text-[#6D5D52] bg-[#FAF7F2] hover:bg-[#F2ECE4] border border-[#E8DEC8] rounded-xl transition"
          >
            取消
          </button>

          <button
            type="button"
            onClick={handleSend}
            disabled={isSubmitting || isManual || !content.trim()}
            className="px-5 py-2.5 rounded-xl text-xs sm:text-sm font-extrabold bg-[#06C755] hover:bg-[#05b34c] text-white shadow-md transition disabled:opacity-50 flex items-center gap-1.5"
          >
            {isSubmitting ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>發送中...</span>
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                <span>🚀 立即發送至顧客 LINE</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
