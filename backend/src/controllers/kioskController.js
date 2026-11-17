/**
 * 報到機 SGK1 v1 端點控制器（Item 1 先建立加密信封骨架；sync 與 access 於 Item 2／Item 3 實作）
 */

export const postKioskSyncHandler = async (req, res) => {
  try {
    return res.kioskReply({
      ok: true,
      code: 'OK',
      body: {
        sync_interval_s: 180,
        tz_offset_min: 480,
        config_rev: 0,
        days: [],
        slides: { rev: 0, items: [] },
        floor_map: null,
        firmware: null,
        ack_event_ids: []
      }
    });
  } catch (err) {
    console.error('[kioskController] sync error:', err);
    return res.kioskReply({ ok: false, code: 'SERVER_ERROR', body: {} });
  }
};

export const postKioskAccessHandler = async (req, res) => {
  try {
    return res.kioskReply({
      ok: true,
      code: 'OK',
      body: {
        result: 'NOT_FOUND',
        open_door: false
      }
    });
  } catch (err) {
    console.error('[kioskController] access error:', err);
    return res.kioskReply({ ok: false, code: 'SERVER_ERROR', body: {} });
  }
};
