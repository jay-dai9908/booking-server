import prisma from '../prismaClient.js';

export const ensureDefaultPaymentMethods = async () => {
  const defaults = [
    {
      code: 'ctbc_pool',
      name: '中國信託 社群收款（專屬一次性帳號）',
      method_type: 'POOL_ACCOUNT',
      is_enabled: true,
      display_instructions:
        '系統已自動為您分配專屬的「中國信託 一次性社群收款帳號」，請於期限內完成轉帳。轉帳後可點擊下方按鈕直接傳送 LINE 訊息至官方帳號進行對帳！',
      require_last5: true,
      show_line_verify_btn: true,
      sort_order: 1
    },
    {
      code: 'bank_transfer',
      name: '一般銀行匯款 / ATM 轉帳（多銀行選擇）',
      method_type: 'MULTI_BANK',
      is_enabled: true,
      display_instructions:
        '請選擇以下任一銀行帳號完成轉帳，轉帳後請填寫「匯款帳號末五碼」，我們將由專人為您核對確認！',
      bank_accounts_json: [
        {
          bank_code: '822',
          bank_name: '中國信託商業銀行',
          account: '1234-5678-9012',
          holder: '拾光製所'
        },
        {
          bank_code: '013',
          bank_name: '國泰世華商業銀行',
          account: '0012-3456-7890',
          holder: '拾光製所'
        },
        {
          bank_code: '812',
          bank_name: '台新國際商業銀行',
          account: '2088-0123-4567',
          holder: '拾光製所'
        }
      ],
      require_last5: true,
      show_line_verify_btn: true,
      sort_order: 2
    },
    {
      code: 'jkopay',
      name: '街口支付 JKO Pay',
      method_type: 'EWALLET',
      is_enabled: true,
      display_instructions:
        '請使用街口支付 App 轉帳至指定街口帳號（或掃描店家收款碼），轉帳後請於下方填寫「街口帳號末五碼或手機號碼」，謝謝！',
      bank_accounts_json: [
        {
          bank_code: '396',
          bank_name: '街口支付 (396)',
          account: '901234567',
          holder: '拾光製所'
        }
      ],
      require_last5: true,
      show_line_verify_btn: true,
      sort_order: 3
    },
    {
      code: 'onsite',
      name: '門市現場支付訂金',
      method_type: 'ONSITE',
      is_enabled: true,
      display_instructions:
        '請於下單後 2 天內親至【拾光製所】門市現場出示預購單號並完成訂金支付，逾期系統將自動釋出名額。',
      require_last5: false,
      show_line_verify_btn: true,
      sort_order: 4
    }
  ];

  for (const m of defaults) {
    await prisma.paymentMethodConfig.upsert({
      where: { code: m.code },
      update: {},
      create: m
    });
  }
};

export const ensureDefaultProducts = async () => {
  const defaults = [
    {
      code: 'bundle_221',
      name: '📦 221色拼豆全配套裝',
      category: 'bundle',
      description:
        '全色系一次擁有！包含 221 色高品質融合豆各 1 包（每包約 1000 顆 / 10g），加贈專屬 3D 列印工具組（可許願風格或 IP 角色）與中板內免費代燙 5 件集次卡！',
      price: 3600,
      is_preorder: true,
      deposit_amount: 600,
      estimated_arrival_text: '預計 11/10 ~ 11/15 到貨，商品抵達門市後將發送 LINE 訊息通知取貨',
      allow_wish_input: true,
      wish_input_placeholder: '可輸入喜歡的顏色、款式或 IP 角色（例如：吉伊卡哇、馬卡龍粉、雙針筆優先）',
      bonus_pass_plan_code: 'free_ironing_5',
      visibility_status: 'ACTIVE',
      sort_order: 1
    },
    {
      code: 'beads_221_10g',
      name: '🌈 221色高品質融合豆 (每包10g/約1000顆)',
      category: 'beads',
      description:
        '2.6mm 高精準融合豆，色澤鮮豔飽滿、熨燙平整不易脆化。單包 $16，享多包自動階梯優惠：滿 10 包 $150（每包 $15）、滿 20 包 $280（每包 $14）！下單時可於備註填寫所需色號。',
      price: 16,
      is_preorder: true,
      deposit_amount: 0,
      estimated_arrival_text: '預計 11/10 ~ 11/15 到貨',
      allow_wish_input: false,
      tier_pricing: [
        { qty: 20, price: 280 },
        { qty: 10, price: 150 },
        { qty: 1, price: 16 }
      ],
      visibility_status: 'ACTIVE',
      sort_order: 2
    },
    {
      code: 'tool_pen_single',
      name: '🖊️ 3D列印 單針拼豆筆',
      category: 'tools',
      description: '原創人體工學握柄，單顆取豆精準順手，長時間製作手腕不痠痛。',
      price: 120,
      is_preorder: true,
      deposit_amount: 0,
      estimated_arrival_text: '預計 11/10 ~ 11/15 到貨',
      allow_wish_input: false,
      visibility_status: 'ACTIVE',
      sort_order: 3
    },
    {
      code: 'tool_pen_double',
      name: '🖊️ 3D列印 雙針拼豆筆',
      category: 'tools',
      description: '大面積快速鋪豆神器！雙針定位一次抓取，效率加倍提升。',
      price: 120,
      is_preorder: true,
      deposit_amount: 0,
      estimated_arrival_text: '預計 11/10 ~ 11/15 到貨',
      allow_wish_input: false,
      visibility_status: 'ACTIVE',
      sort_order: 4
    },
    {
      code: 'tool_tray',
      name: '🍽️ 3D列印 立豆盤',
      category: 'tools',
      description: '特殊斜紋蜂巢導槽，搖一搖拼豆自動直立排好，快速插豆不翻車。',
      price: 100,
      is_preorder: true,
      deposit_amount: 0,
      estimated_arrival_text: '預計 11/10 ~ 11/15 到貨',
      allow_wish_input: false,
      visibility_status: 'ACTIVE',
      sort_order: 5
    },
    {
      code: 'tool_shovel',
      name: '🥄 3D列印 豆鏟',
      category: 'tools',
      description: '專用鏟豆弧度設計，收納清潔或換色鏟豆一秒搞定。',
      price: 110,
      is_preorder: true,
      deposit_amount: 0,
      estimated_arrival_text: '預計 11/10 ~ 11/15 到貨',
      allow_wish_input: false,
      visibility_status: 'ACTIVE',
      sort_order: 6
    },
    {
      code: 'tool_tray_shovel_2in1',
      name: '✨ 3D列印 立豆盤豆鏟二合一',
      category: 'tools',
      description: '立豆盤結合磁吸豆鏟，出門手作攜帶最便利。',
      price: 200,
      is_preorder: true,
      deposit_amount: 0,
      estimated_arrival_text: '預計 11/10 ~ 11/15 到貨',
      allow_wish_input: false,
      visibility_status: 'ACTIVE',
      sort_order: 7
    },
    {
      code: 'tool_fries_lifter',
      name: '🍟 3D列印 薯條豆鏟立豆器',
      category: 'tools',
      description: '可愛趣味薯條造型，結合立豆與鏟豆多功能，拍照打卡超吸睛！',
      price: 80,
      is_preorder: true,
      deposit_amount: 0,
      estimated_arrival_text: '預計 11/10 ~ 11/15 到貨',
      allow_wish_input: false,
      visibility_status: 'ACTIVE',
      sort_order: 8
    },
    {
      code: 'board_52',
      name: '📏 耐高溫加長釘豆板 52×52小板',
      category: 'boards',
      description: '特製加長定位釘，拼豆不易脫落移位，可耐熨燙高溫不易變形。',
      price: 40,
      is_preorder: true,
      deposit_amount: 0,
      estimated_arrival_text: '預計 11/10 ~ 11/15 到貨',
      allow_wish_input: false,
      visibility_status: 'ACTIVE',
      sort_order: 9
    },
    {
      code: 'board_78',
      name: '📏 耐高溫加長釘豆板 78×78中板',
      category: 'boards',
      description: '中型作品最合適尺寸，加長釘穩固卡豆，邊緣可拼接無限延伸。',
      price: 75,
      is_preorder: true,
      deposit_amount: 0,
      estimated_arrival_text: '預計 11/10 ~ 11/15 到貨',
      allow_wish_input: false,
      visibility_status: 'ACTIVE',
      sort_order: 10
    },
    {
      code: 'board_104',
      name: '📏 耐高溫加長釘豆板 104×104大板',
      category: 'boards',
      description: '大型巨幅作品必備，大面積平整受熱不易翹曲。',
      price: 120,
      is_preorder: true,
      deposit_amount: 0,
      estimated_arrival_text: '預計 11/10 ~ 11/15 到貨',
      allow_wish_input: false,
      visibility_status: 'ACTIVE',
      sort_order: 11
    },
    {
      code: 'cloth_30x30',
      name: '🧻 高品質粗紋烘焙布 30×30cm',
      category: 'cloth',
      description: '耐高溫抗撕裂，表面微粗紋理使拼豆燙後呈現自然啞光霧面質感。',
      price: 45,
      is_preorder: true,
      deposit_amount: 0,
      estimated_arrival_text: '預計 11/10 ~ 11/15 到貨',
      allow_wish_input: false,
      visibility_status: 'ACTIVE',
      sort_order: 12
    },
    {
      code: 'cloth_20x30',
      name: '🧻 高品質粗紋烘焙布 20×30cm',
      category: 'cloth',
      description: '長條型作品專用尺寸，好鋪好燙不易滑動。',
      price: 30,
      is_preorder: true,
      deposit_amount: 0,
      estimated_arrival_text: '預計 11/10 ~ 11/15 到貨',
      allow_wish_input: false,
      visibility_status: 'ACTIVE',
      sort_order: 13
    },
    {
      code: 'cloth_15x20',
      name: '🧻 高品質粗紋烘焙布 15×20cm',
      category: 'cloth',
      description: '小吊飾作品小巧便利，導熱均勻且可反覆清洗重複使用。',
      price: 15,
      is_preorder: true,
      deposit_amount: 0,
      estimated_arrival_text: '預計 11/10 ~ 11/15 到貨',
      allow_wish_input: false,
      visibility_status: 'ACTIVE',
      sort_order: 14
    }
  ];

  for (const p of defaults) {
    await prisma.product.upsert({
      where: { code: p.code },
      update: {},
      create: p
    });
  }
};

export const ensureDefaultPassPlans = async () => {
  const defaults = [
    {
      code: 'free_ironing_5',
      name: '🔥 中板內免費代燙服務 5 件集次卡',
      pass_type: 'PUNCH_CARD',
      price: 0,
      is_purchasable_online: false,
      total_quota: 5,
      valid_days: null,
      day_restriction: 'ALL',
      description: '預購 221 色全配套裝專屬贈品！憑此卡享門市免費代燙 78x78 中板內拼豆作品 5 次。',
      is_active: true
    },
    {
      code: 'half_price_voucher',
      name: '🎟️ 手作體驗 5 折優惠券',
      pass_type: 'DISCOUNT_VOUCHER',
      price: 0,
      is_purchasable_online: false,
      total_quota: 1,
      valid_days: 60,
      day_restriction: 'ALL',
      discount_percent: 50,
      description: '手作時數結帳享 5 折折抵（限單次預約訂單使用）。',
      is_active: true
    },
    {
      code: 'monthly_pass_demo',
      name: '🌙 拾光手作平日暢玩月卡（範本）',
      pass_type: 'MONTHLY_PASS',
      price: 1500,
      is_purchasable_online: false,
      total_quota: null,
      valid_days: 30,
      day_restriction: 'WEEKDAY_ONLY',
      max_hours_per_day: 3,
      description: '開通後 30 天內，週一至週五無限次入店暢玩（每日最多 3 小時）。',
      is_active: true
    }
  ];

  for (const plan of defaults) {
    await prisma.passPlan.upsert({
      where: { code: plan.code },
      update: {},
      create: plan
    });
  }
};
