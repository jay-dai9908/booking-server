import axios from 'axios';
import prisma from '../prismaClient.js';

/**
 * Get active LINE Messaging API Channel Access Token
 * Priority: Database GlobalSetting.line_messaging_token -> process.env.LINE_MESSAGING_ACCESS_TOKEN
 */
export const getMessagingToken = async () => {
  try {
    const globalSetting = await prisma.globalSetting.findUnique({
      where: { id: 1 },
      select: { line_messaging_token: true }
    });
    if (globalSetting?.line_messaging_token && globalSetting.line_messaging_token.trim()) {
      return globalSetting.line_messaging_token.trim();
    }
  } catch (err) {
    console.warn('[lineMessaging] Error fetching token from DB:', err.message);
  }
  return process.env.LINE_MESSAGING_ACCESS_TOKEN || '';
};

/**
 * Send LINE Push Message to a single user
 * @param {string} lineUserId - Target user's LINE userId
 * @param {Array|Object} messages - One message object or array of message objects (max 5)
 */
export const sendLinePushMessage = async (lineUserId, messages) => {
  if (!lineUserId || typeof lineUserId !== 'string' || lineUserId.startsWith('manual_')) {
    const err = new Error('此會員為櫃檯手動建檔，尚未綁定真實 LINE 帳號');
    err.status = 400;
    throw err;
  }

  const token = await getMessagingToken();
  if (!token) {
    const err = new Error('尚未設定 LINE Messaging Channel Access Token，請先至後台「系統全域設定」填寫');
    err.status = 400;
    throw err;
  }

  const messageList = Array.isArray(messages) ? messages : [messages];
  if (messageList.length === 0) {
    const err = new Error('訊息內容不能為空');
    err.status = 400;
    throw err;
  }

  try {
    const response = await axios.post(
      'https://api.line.me/v2/bot/message/push',
      {
        to: lineUserId,
        messages: messageList.slice(0, 5)
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const errorDetails = error.response?.data;
    console.error('[lineMessaging] Push message failed:', status, errorDetails || error.message);

    let friendlyMessage = '發送 LINE 訊息失敗';
    if (status === 400) {
      if (errorDetails?.message === 'Failed to send messages') {
        friendlyMessage = '發送失敗：該會員尚未加入官方帳號好友、已封鎖官方帳號，或是該會員的 LINE 帳號屬於舊的 Provider（請讓該會員重新登入一次預約系統以更新 LINE 識別碼）';
      } else if (errorDetails?.message) {
        const detailsText = Array.isArray(errorDetails.details) && errorDetails.details.length > 0
          ? ` (${errorDetails.details.map(d => `${d.property ? d.property + ': ' : ''}${d.message}`).join('; ')})`
          : '';
        friendlyMessage = `LINE 訊息格式錯誤：${errorDetails.message}${detailsText}`;
      } else {
        friendlyMessage = '發送失敗：LINE API 回報請求無效 (400)';
      }
    } else if (status === 401) {
      friendlyMessage = 'LINE Messaging Token 無效或已過期，請至系統全域設定檢查 Channel Access Token';
    } else if (status === 429) {
      friendlyMessage = '已達 LINE 官方帳號當月推播訊息配額上限';
    } else if (errorDetails?.message) {
      friendlyMessage = `LINE 發送錯誤：${errorDetails.message}`;
    }

    const err = new Error(friendlyMessage);
    err.status = status || 500;
    err.details = errorDetails;
    throw err;
  }
};

/**
 * Build a branded Flex Message Bubble for 《拾光製所》
 * Strict rule: Never display any seat number (e.g. A1, B2) or split seating phrasing
 */
export const buildBrandFlexMessage = ({
  title,
  subtitle,
  bodyText,
  infoRows = [],
  buttonLabel,
  buttonUrl,
  tagText
}) => {
  // Filter out any accidental seat-related keys or text
  const safeInfoRows = infoRows
    .filter(row => {
      if (!row || !row.label) return false;
      const lowerLabel = String(row.label).toLowerCase();
      if (lowerLabel.includes('座位') || lowerLabel.includes('桌號') || lowerLabel.includes('seat')) {
        return false;
      }
      return true;
    })
    .map(row => ({
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: [
        {
          type: 'text',
          text: String(row.label),
          size: 'xs',
          color: '#8C8279',
          flex: 4
        },
        {
          type: 'text',
          text: String(row.value),
          size: 'xs',
          color: row.color || '#3E332B',
          weight: 'bold',
          flex: 6,
          align: 'end',
          wrap: true
        }
      ]
    }));

  const bubbleContents = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#8B5B43',
      paddingAll: '18px',
      spacing: 'xs',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            {
              type: 'text',
              text: '拾光製所 SHIGUANG STUDIO',
              size: 'xxs',
              color: '#FAF7F2',
              weight: 'bold'
            },
            ...(tagText
              ? [
                  {
                    type: 'text',
                    text: tagText,
                    size: 'xxs',
                    color: '#FAF7F2',
                    align: 'end',
                    weight: 'bold'
                  }
                ]
              : [])
          ]
        },
        {
          type: 'text',
          text: title || '會員專屬通知',
          size: 'lg',
          color: '#FFFFFF',
          weight: 'bold',
          wrap: true,
          margin: 'sm'
        },
        ...(subtitle
          ? [
              {
                type: 'text',
                text: subtitle,
                size: 'xs',
                color: '#E8DEC8',
                wrap: true
              }
            ]
          : [])
      ]
    },
    body: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#FAF7F2',
      paddingAll: '18px',
      spacing: 'md',
      contents: [
        ...(bodyText
          ? [
              {
                type: 'text',
                text: bodyText,
                size: 'sm',
                color: '#3E332B',
                wrap: true,
                lineSpacing: '4px'
              }
            ]
          : []),
        ...(safeInfoRows.length > 0
          ? [
              {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#FFFFFF',
                cornerRadius: '12px',
                paddingAll: '14px',
                spacing: 'sm',
                borderColor: '#E8DEC8',
                borderWidth: '1px',
                contents: safeInfoRows
              }
            ]
          : [])
      ]
    }
  };

  if (buttonLabel && buttonUrl) {
    bubbleContents.footer = {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#FAF7F2',
      paddingAll: '14px',
      paddingTop: '0px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#8B5B43',
          height: 'sm',
          action: {
            type: 'uri',
            label: buttonLabel,
            uri: buttonUrl
          }
        }
      ]
    };
  }

  return {
    type: 'flex',
    altText: title || '拾光製所 通知訊息',
    contents: bubbleContents
  };
};

/**
 * Format booking reference to consistent BK-XXXX-XXXX display
 */
export const formatBookingRef = (ref) => {
  if (!ref) return '';
  const str = String(ref);
  if (str.length <= 12) return str;
  return `BK-${str.slice(0, 4).toUpperCase()}-${str.slice(-4).toUpperCase()}`;
};

/**
 * Format date string safely as YYYY/MM/DD
 */
const formatDateStr = (dateVal) => {
  if (!dateVal) return '';
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return String(dateVal);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
};

/**
 * Send automated booking confirmation Flex card
 */
export const sendBookingConfirmationNotification = async (reservation, user) => {
  if (!user?.line_user_id || user.line_user_id.startsWith('manual_')) return;

  const shortRef = formatBookingRef(reservation.booking_ref);

  const frontendUrl = process.env.FRONTEND_URL || 'https://shiguangstudio.com';
  const historyUrl = `${frontendUrl}/history`;

  const infoRows = [
    { label: '預約單號', value: shortRef },
    { label: '預約日期', value: formatDateStr(reservation.session_date) },
    { label: '預約時段', value: reservation.time_range || '已排定時段' },
    { label: '預約人數', value: `${reservation.pax} 位` }
  ];

  if (reservation.equipment_summary) {
    infoRows.push({ label: '智能拼豆板', value: reservation.equipment_summary });
  }

  if (reservation.total_amount != null) {
    infoRows.push({
      label: '應付金額',
      value: `NT$ ${reservation.total_amount.toLocaleString()}`,
      color: '#8B5B43'
    });
  }

  const flexMessage = buildBrandFlexMessage({
    title: '預約成功電子憑證',
    subtitle: '感謝您的預約，我們期待您的蒞臨！',
    bodyText: `親愛的 ${user.name || '貴賓'} 您好：\n您於【拾光製所】的手作時段已預約完成！現場預約保留 15 分鐘，請預留充裕時間前來門市體驗。`,
    infoRows,
    buttonLabel: '查看 / 管理我的預約',
    buttonUrl: historyUrl,
    tagText: '✅ 預約確認'
  });

  return sendLinePushMessage(user.line_user_id, [flexMessage]);
};

/**
 * Send automated booking cancellation notification
 */
export const sendBookingCancellationNotification = async (reservation, user, cancelledBy = 'admin') => {
  if (!user?.line_user_id || user.line_user_id.startsWith('manual_')) return;

  const shortRef = formatBookingRef(reservation.booking_ref);

  const frontendUrl = process.env.FRONTEND_URL || 'https://shiguangstudio.com';
  const bookingUrl = `${frontendUrl}/booking`;

  const infoRows = [
    { label: '預約單號', value: shortRef },
    { label: '預約日期', value: formatDateStr(reservation.session_date) },
    { label: '預約時段', value: reservation.time_range || '原時段' },
    { label: '取消來源', value: cancelledBy === 'admin' ? '門市人員取消' : '顧客自行取消' }
  ];

  return sendLinePushMessage(user.line_user_id, [flexMessage]);
};

/**
 * Send preorder deposit verified notification
 */
export const sendProductOrderDepositVerifiedNotification = async (order, user) => {
  if (!user?.line_user_id || user.line_user_id.startsWith('manual_')) return;

  const frontendUrl = process.env.FRONTEND_URL || 'https://shiguangstudio.com';
  const historyUrl = `${frontendUrl}/history`;

  const itemsSummary = (order.items || [])
    .map(i => `${i.product_name_snapshot} x${i.quantity}`)
    .join('、') || '預購商品';

  const infoRows = [
    { label: '預購單號', value: order.order_ref },
    { label: '預購品項', value: itemsSummary },
    { label: '已收訂金', value: `NT$ ${(order.paid_amount || 0).toLocaleString()}`, color: '#2E7D32' },
    { label: '取貨待付尾款', value: `NT$ ${(order.balance_amount || 0).toLocaleString()}`, color: '#8B5B43' }
  ];

  if (order.estimated_arrival) {
    infoRows.push({ label: '預計到貨', value: order.estimated_arrival });
  }

  const flexMessage = buildBrandFlexMessage({
    title: '預購訂金收款成功',
    subtitle: '您的訂金已成功對帳完成！',
    bodyText: `親愛的 ${user.name || '貴賓'} 您好：\n您於【拾光製所】的預購訂單訂金款項已對帳完成！商品抵達門市時我們將第一時間透過 LINE 通知您前來取貨。`,
    infoRows,
    buttonLabel: '查看我的預購訂單',
    buttonUrl: historyUrl,
    tagText: '🎉 款項對帳完成'
  });

  return sendLinePushMessage(user.line_user_id, [flexMessage]);
};

/**
 * Send product arrival notification
 */
export const sendProductArrivalNotification = async (order, user) => {
  if (!user?.line_user_id || user.line_user_id.startsWith('manual_')) return;

  const frontendUrl = process.env.FRONTEND_URL || 'https://shiguangstudio.com';
  const historyUrl = `${frontendUrl}/history`;

  const itemsSummary = (order.items || [])
    .map(i => `${i.product_name_snapshot} x${i.quantity}`)
    .join('、') || '預購商品';

  const infoRows = [
    { label: '預購單號', value: order.order_ref },
    { label: '到貨品項', value: itemsSummary },
    { label: '取貨地點', value: '拾光製所 門市櫃檯' }
  ];

  if (order.balance_amount > 0) {
    infoRows.push({
      label: '取貨待付尾款',
      value: `NT$ ${order.balance_amount.toLocaleString()}`,
      color: '#8B5B43'
    });
  }

  const flexMessage = buildBrandFlexMessage({
    title: '商品已到貨取件通知',
    subtitle: '您預購的商品已送達門市囉！',
    bodyText: `親愛的 ${user.name || '貴賓'} 您好：\n您預購的拼豆商品已備妥抵達門市！歡迎於營業時間內攜帶手機前來門市櫃檯出示單號領取作品與套裝。`,
    infoRows,
    buttonLabel: '查看預購單號與取貨詳情',
    buttonUrl: historyUrl,
    tagText: '🎁 到貨取件通知'
  });

  return sendLinePushMessage(user.line_user_id, [flexMessage]);
};
