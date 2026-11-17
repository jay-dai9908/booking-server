#!/usr/bin/env node
import crypto from 'crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const { default: prisma } = await import('../src/prismaClient.js');
const { wrapPairKey, pairingString } = await import('../src/services/kiosk/sgk1.js');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function printUsage() {
  console.log(`用法：
  新增並配對報到機：
    node backend/scripts/kiosk-pair.mjs --name "門口報到機" --url http://<站台位址>

  替換既有報到機金鑰（舊金鑰立即失效）：
    node backend/scripts/kiosk-pair.mjs --replace <device_id> --url http://<站台位址>

  列出已登記報到機（不含金鑰）：
    node backend/scripts/kiosk-pair.mjs --list

  停用指定報到機：
    node backend/scripts/kiosk-pair.mjs --disable <device_id>

注意事項：
  1. 配對金鑰先經 HMAC-SHA256(JWT_SECRET, "kiosk-key-wrap") + AES-256-GCM 加密再存進資料庫。
  2. 若更換伺服器 JWT_SECRET，所有報到機都必須重新執行配對！
  3. 配對字串與終端機 QR 只會顯示這一次，不會再從資料庫顯示原文。`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || Object.keys(args).length === 0) {
    printUsage();
    return;
  }

  if (args.list) {
    const devices = await prisma.kioskDevice.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        name: true,
        is_active: true,
        paired_at: true,
        last_seen_at: true,
        last_ip: true,
        fw_version: true,
        created_at: true
      }
    });
    if (devices.length === 0) {
      console.log('尚未建立任何報到機裝置。');
    } else {
      console.table(
        devices.map((d) => ({
          id: d.id,
          name: d.name,
          is_active: d.is_active,
          fw_version: d.fw_version || '-',
          paired_at: d.paired_at ? d.paired_at.toISOString() : '-',
          last_seen_at: d.last_seen_at ? d.last_seen_at.toISOString() : '-',
          last_ip: d.last_ip || '-'
        }))
      );
    }
    return;
  }

  if (args.disable !== undefined) {
    const id = Number(args.disable);
    if (!Number.isInteger(id) || id < 1) {
      console.error('--disable 需要正確的裝置 id');
      process.exitCode = 1;
      return;
    }
    const existing = await prisma.kioskDevice.findUnique({ where: { id } });
    if (!existing) {
      console.error(`找不到裝置 id=${id}`);
      process.exitCode = 1;
      return;
    }
    await prisma.kioskDevice.update({ where: { id }, data: { is_active: false } });
    console.log(`已停用報到機 #${id}（${existing.name}）。`);
    return;
  }

  if (args.replace !== undefined) {
    const id = Number(args.replace);
    const url = args.url;
    if (!Number.isInteger(id) || id < 1 || !url || !/^https?:\/\//.test(String(url))) {
      console.error('--replace <device_id> 必須搭配有效的 --url http(s)://...');
      process.exitCode = 1;
      return;
    }
    const existing = await prisma.kioskDevice.findUnique({ where: { id } });
    if (!existing) {
      console.error(`找不到裝置 id=${id}`);
      process.exitCode = 1;
      return;
    }
    const pairKey = crypto.randomBytes(32);
    const wrapped = wrapPairKey(pairKey);
    await prisma.kioskDevice.update({
      where: { id },
      data: { key_wrapped: wrapped, is_active: true, paired_at: new Date() }
    });
    const str = pairingString(url, id, pairKey);
    const qrText = await QRCode.toString(str, { type: 'terminal', small: true });
    console.log(`\n=== 已重新產生報到機 #${id}（${existing.name}）配對金鑰（舊金鑰已立即失效）===`);
    console.log('提醒：金鑰經 JWT_SECRET 加密保存；若更換 JWT_SECRET 需重新配對。');
    console.log(`\n配對字串：\n${str}\n`);
    console.log(qrText);
    return;
  }

  const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : '門口報到機';
  const url = args.url;
  if (!url || !/^https?:\/\//.test(String(url))) {
    console.error('必須指定有效的 --url http://<站台位址>');
    process.exitCode = 1;
    return;
  }

  const pairKey = crypto.randomBytes(32);
  const wrapped = wrapPairKey(pairKey);
  const device = await prisma.kioskDevice.create({
    data: {
      name,
      key_wrapped: wrapped,
      is_active: true,
      paired_at: new Date()
    }
  });

  const str = pairingString(url, device.id, pairKey);
  const qrText = await QRCode.toString(str, { type: 'terminal', small: true });
  console.log(`\n=== 新報到機配對資訊：#${device.id}（${device.name}）===`);
  console.log('提醒：金鑰只顯示這一次，資料庫內已以 HMAC-SHA256(JWT_SECRET, "kiosk-key-wrap") + AES-256-GCM 加密。');
  console.log('若更換 JWT_SECRET，須重新執行配對！');
  console.log(`\n配對字串：\n${str}\n`);
  console.log(qrText);
}

main()
  .catch((err) => {
    console.error('[kiosk-pair] 失敗:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
