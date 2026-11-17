// frontend/src/assets/kiosk-icons/index.js
export const KIOSK_ICONS = {
  sofa: {
    name: '沙發',
    inner: '<path d="M5 10V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2"/><path d="M3 10a2 2 0 0 0-2 2v5h22v-5a2 2 0 0 0-4 0v2H5v-2a2 2 0 0 0-2-2z"/><path d="M4 17v2M20 17v2"/>'
  },
  counter: {
    name: '櫃檯',
    inner: '<rect x="7" y="3" width="10" height="5" rx="1"/><path d="M12 8v3"/><path d="M4 11h16l1.2 9H2.8z"/><path d="M8 15.5h8"/>'
  },
  iron: {
    name: '燙豆區',
    inner: '<path d="M3 18l1.6-5.2A5 5 0 0 1 9.4 9H17a4 4 0 0 1 4 4v5z"/><path d="M9 9V6.5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 19 6.5v3"/><path d="M7 21.5h12"/>'
  },
  beads: {
    name: '拼豆牆',
    inner: '<circle cx="7" cy="7" r="3.2"/><circle cx="17" cy="7" r="3.2"/><circle cx="7" cy="17" r="3.2"/><circle cx="17" cy="17" r="3.2"/>'
  },
  locker: {
    name: '置物櫃',
    inner: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M12 3v18"/><path d="M9 9v2M15 9v2"/>'
  },
  shelf: {
    name: '展示架',
    inner: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M4 9h16M4 15h16"/>'
  },
  toilet: {
    name: '廁所',
    inner: '<circle cx="7" cy="4.5" r="2"/><path d="M4.5 9h5l1 6H9v6H5v-6H3.5z"/><circle cx="17" cy="4.5" r="2"/><path d="M14.5 9h5l2 7h-2.5v5h-4v-5H12.5z"/>'
  },
  sink: {
    name: '洗手台',
    inner: '<path d="M12 3v4M9 3h6"/><path d="M3 11h18v1a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6z"/><path d="M12 18v3"/>'
  },
  water: {
    name: '飲水',
    inner: '<path d="M12 3s6 6.8 6 11a6 6 0 0 1-12 0c0-4.2 6-11 6-11z"/><path d="M9.5 14.5a2.5 2.5 0 0 0 2.5 2.5"/>'
  },
  trash: {
    name: '垃圾桶',
    inner: '<path d="M4 7h16M10 4h4"/><path d="M6 7l1 14h10l1-14"/><path d="M10 11v6M14 11v6"/>'
  },
  bag: {
    name: '寄物',
    inner: '<path d="M5 8h14l-1 13H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'
  },
  entrance: {
    name: '入口',
    inner: '<path d="M14 3h5v18h-5"/><path d="M3 12h11M10 8l4 4-4 4"/>'
  },
  exit: {
    name: '出口',
    inner: '<path d="M10 3H5v18h5"/><path d="M10 12h11M17 8l4 4-4 4"/>'
  },
  stairs: {
    name: '樓梯',
    inner: '<path d="M3 20h5v-5h5v-5h5V5h3"/>'
  },
  ac: {
    name: '冷氣',
    inner: '<rect x="2" y="4" width="20" height="8" rx="2"/><path d="M6 15v2M12 15v4M18 15v2"/>'
  }
};

export const KIOSK_PALETTE = {
  grey: { label: '一般灰', bg: '#E9E6E1', text: '#7D736A' },
  brown: { label: '棕色', bg: '#E9D6C6', text: '#7A4F3A' },
  coral: { label: '珊瑚', bg: '#F5DDD2', text: '#8A4A36' },
  blue: { label: '灰藍', bg: '#DCE4EC', text: '#4F6577' },
  honey: { label: '蜂蜜', bg: '#F4E4C4', text: '#7D5718' },
  sage: { label: '鼠尾草', bg: '#DFE9D9', text: '#52704A' },
  lavender: { label: '薰衣草', bg: '#E6E0EE', text: '#5E5378' },
  pink: { label: '粉紅', bg: '#F6DDE3', text: '#8A4057' }
};
