import '../src/loadEnv.js';
import readline from 'readline/promises';
import { pathToFileURL } from 'url';
import prisma from '../src/prismaClient.js';
import {
  cliGetAdminGuardStatus,
  cliResetAdminTotp,
  cliUnlockAdminLogin
} from '../src/services/auth/adminLoginGuard.js';

function formatTime(dt) {
  if (!dt) return '-';
  return new Date(dt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
}

async function main() {
  const args = new Set(process.argv.slice(2));

  try {
    if (args.has('--status')) {
      const status = await cliGetAdminGuardStatus(prisma);
      console.log(`鎖定狀態: ${status.locked ? `已鎖定 (自 ${formatTime(status.locked_at)})` : '未鎖定'}`);
      console.log(`驗證器狀態: ${status.totp_enabled ? '已啟用' : '未設定'}`);
      console.log(`剩餘備用碼: ${status.backup_codes_remaining} 組`);
      console.log(`近 10 分鐘失敗次數: 密碼 ${status.recent_password_failures_10m} 次 / 解鎖碼 ${status.recent_unlock_failures_10m} 次`);
      console.log('最近事件 (最多 10 筆):');
      if (status.recent_events.length === 0) {
        console.log('  (無紀錄)');
      } else {
        for (const ev of status.recent_events) {
          console.log(`  - ${formatTime(ev.created_at)} | ${ev.type} | IP: ${ev.ip || '-'}${ev.note ? ` | ${ev.note}` : ''}`);
        }
      }
      return;
    }

    if (args.has('--reset-totp')) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question('此操作將清除後台驗證器與所有備用碼，請輸入 RESET 確認：');
        if (answer.trim() !== 'RESET') {
          console.log('已取消重設。');
          process.exitCode = 1;
          return;
        }
      } finally {
        rl.close();
      }
      await cliResetAdminTotp(prisma);
      console.log('已重設後台驗證器與備用碼');
      return;
    }

    const res = await cliUnlockAdminLogin(prisma);
    if (!res.wasLocked) {
      console.log('目前沒有鎖定');
    } else {
      console.log('已解除後台登入鎖定');
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[admin-unlock] Error:', err?.message || err);
    process.exit(1);
  });
}
