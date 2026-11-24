export const METHOD_LABELS = {
  qr: '條碼',
  phone: '電話',
  backup_code: '備用密碼',
  keypad: '鍵盤'
};

export const RESULT_LABELS = {
  FIRST_CHECKIN: '報到成功',
  RE_ENTRY: '再次進門',
  TOO_EARLY: '還沒開放',
  UNVERIFIED: '款項核對中',
  QR_EXPIRED: '條碼過期',
  NOT_FOUND: '查無預約',
  ENDED: '已結束',
  NORMAL_DAY: '一般營業日',
  BACKUP_OPEN: '備用密碼開門',
  PAD_LOCKED: '鍵盤連續輸錯，已鎖定'
};

export const RESULT_STYLES = {
  FIRST_CHECKIN: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  RE_ENTRY: 'bg-sky-50 text-sky-700 border-sky-200',
  BACKUP_OPEN: 'bg-amber-50 text-amber-800 border-amber-200',
  TOO_EARLY: 'bg-stone-100 text-stone-700 border-stone-200',
  UNVERIFIED: 'bg-orange-50 text-orange-700 border-orange-200',
  QR_EXPIRED: 'bg-rose-50 text-rose-700 border-rose-200',
  NOT_FOUND: 'bg-stone-100 text-stone-600 border-stone-200',
  ENDED: 'bg-stone-100 text-stone-600 border-stone-200',
  NORMAL_DAY: 'bg-stone-100 text-stone-600 border-stone-200',
  PAD_LOCKED: 'bg-rose-50 text-rose-700 border-rose-200'
};

export const KIOSK_BOOKING_STATE_LABELS = {
  unpaid: '未付款',
  reported: '待對帳',
  mismatch: '金額不符',
  confirmed: '未到時間',
  open: '可開門',
  in: '已進場',
  ended: '已結束',
  cancelled: '已取消'
};
