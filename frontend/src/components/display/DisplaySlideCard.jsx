// frontend/src/components/display/DisplaySlideCard.jsx
import React from 'react';
import api from '../../api/axios';

export const DEFAULT_SLIDES_SELF = [
  {
    tag: '今天是半自助日',
    h: '掃條碼\n就能進門',
    lead: '在 LINE 打開「我的預約」，把進場條碼對準門口報到機。沒有條碼也可以輸入預約電話。',
    steps: ['打開 LINE 預約紀錄', '對準門口報到機掃碼', '照螢幕上的座位入座']
  },
  {
    tag: '熨燙說明',
    h: '作品完成後\n放在托盤上',
    lead: '店員會在今天下午到店協助熨燙。請把作品連同底板放在燙豆區的托盤，旁邊放上座位號碼牌。'
  },
  {
    tag: '拼豆小提醒',
    h: '豆子用完\n請倒回原格',
    lead: '色豆架上每一格都有色號。用完請倒回同一格，下一位客人才找得到顏色。'
  }
];

export const DEFAULT_SLIDES_GEN = [
  {
    tag: '歡迎光臨',
    h: '一顆一顆\n拾起時光',
    lead: '線上預約座位與智能板，現場也歡迎直接入座。'
  },
  {
    tag: '智能板',
    h: '大板、小板\n都可以加租',
    lead: '買 3 小時送 1 小時。預約時就能一起租，現場也能向店員加租。'
  },
  {
    tag: '計次不限時卡',
    h: '常來的你\n更划算',
    lead: '一次買多次，每次當天不限時。詳情請洽店員或 LINE。'
  }
];

function resolveSlideImageUrl(slide) {
  const base = (api.defaults.baseURL || '/api').replace(/\/api\/?$/, '');
  if (slide.url) {
    if (/^https?:\/\//i.test(slide.url) || slide.url.startsWith('data:')) {
      return slide.url;
    }
    return `${base}${slide.url.startsWith('/') ? '' : '/'}${slide.url}`;
  }
  if (slide.id && slide.sha256) {
    return `${base}/api/display/files/slides/${slide.id}/${slide.sha256}`;
  }
  return '';
}

function BeadHeartArt({ size = 380 }) {
  const heart = [
    '000000000000',
    '001100001100',
    '011110011110',
    '111111111111',
    '111111111111',
    '111111111111',
    '011111111110',
    '001111111100',
    '000111111000',
    '000011110000',
    '000001100000',
    '000000000000'
  ];
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" aria-hidden="true">
      {heart.map((row, y) =>
        [...row].map((v, x) => (
          <circle
            key={`${x}-${y}`}
            cx={x * 3 + 1.5}
            cy={y * 3 + 1.5}
            r={1.2}
            fill={v === '1' ? '#E7B4A2' : '#F1E6DC'}
          />
        ))
      )}
    </svg>
  );
}

/**
 * Renders uploaded image slides when present for the target set ('self' | 'general'),
 * otherwise falls back to the mock text-based default slides.
 */
export default function DisplaySlideCard({
  setType = 'general',
  slides = [],
  slideIdx = 0
}) {
  const activeUploaded = (Array.isArray(slides) ? slides : []).filter(
    s => s && s.enabled !== false && (!s.set || s.set === setType) && (s.id || s.url)
  );

  if (activeUploaded.length > 0) {
    const idx = slideIdx % activeUploaded.length;
    const current = activeUploaded[idx];
    const imgUrl = resolveSlideImageUrl(current);
    return (
      <div
        data-testid={`display-slide-image-${setType}`}
        className="bg-sg-paper relative overflow-hidden h-full w-full"
        style={{
          borderRadius: 40,
          boxShadow: '0 10px 30px rgba(139,91,67,0.08)'
        }}
      >
        <img
          src={imgUrl}
          alt={current.title || '輪播圖片'}
          className="w-full h-full object-cover block"
        />
        {activeUploaded.length > 1 && (
          <div className="absolute flex" style={{ left: 90, bottom: 54, gap: 14 }}>
            {activeUploaded.map((s, n) => (
              <span
                key={s.id || n}
                className={`rounded-full ${n === idx ? 'bg-sg-peach' : 'bg-sg-line'}`}
                style={{ width: 18, height: 18 }}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const defaults = setType === 'self' ? DEFAULT_SLIDES_SELF : DEFAULT_SLIDES_GEN;
  const idx = slideIdx % defaults.length;
  const sl = defaults[idx];

  return (
    <div
      data-testid={`display-slide-default-${setType}`}
      className="bg-sg-paper relative overflow-hidden h-full w-full"
      style={{
        borderRadius: 40,
        boxShadow: '0 10px 30px rgba(139,91,67,0.08)'
      }}
    >
      <div
        className="grid items-center h-full"
        style={{
          padding: '84px 80px 84px 90px',
          gridTemplateColumns: '1fr 470px',
          gap: 60
        }}
      >
        <div>
          <span
            className="inline-block font-body font-bold text-sg-peach-ink bg-sg-peach-soft rounded-full"
            style={{ fontSize: 30, padding: '8px 26px', letterSpacing: '0.06em' }}
          >
            {sl.tag}
          </span>
          <h2
            className="font-display font-bold text-sg-ink whitespace-pre-line"
            style={{
              fontSize: 104,
              lineHeight: 1.18,
              margin: '28px 0',
              letterSpacing: '0.03em'
            }}
          >
            {sl.h}
          </h2>
          <div
            className="text-sg-muted"
            style={{ fontSize: 38, lineHeight: 1.65, maxWidth: 900 }}
          >
            {sl.lead}
          </div>
        </div>

        {sl.steps ? (
          <div className="flex flex-col" style={{ gap: 26, fontSize: 34 }}>
            {sl.steps.map((step, n) => (
              <div key={n} className="flex items-center text-sg-ink" style={{ gap: 22 }}>
                <i
                  className="not-italic font-num font-extrabold rounded-full bg-sg-peach text-sg-paper flex items-center justify-center flex-none"
                  style={{ width: 72, height: 72, fontSize: 38 }}
                >
                  {n + 1}
                </i>
                <span>{step}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center" style={{ width: 420, height: 420 }}>
            <BeadHeartArt size={380} />
          </div>
        )}

        <div className="absolute flex" style={{ left: 90, bottom: 54, gap: 14 }}>
          {defaults.map((_, n) => (
            <span
              key={n}
              className={`rounded-full ${n === idx ? 'bg-sg-peach' : 'bg-sg-line'}`}
              style={{ width: 18, height: 18 }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
