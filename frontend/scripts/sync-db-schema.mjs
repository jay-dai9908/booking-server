import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, '..', '..', 'backend');

function runStep(cmd, description) {
  try {
    console.log(`[sync-db-schema] 執行：${cmd}`);
    execSync(cmd, { cwd: backendDir, stdio: 'inherit', env: process.env });
  } catch (err) {
    console.error(`資料庫結構同步失敗，部署中止（步驟：${description}）`);
    console.error(err?.message || err);
    process.exit(1);
  }
}

runStep('npx prisma generate', 'prisma generate');

if (process.env.SKIP_DB_PUSH === '1') {
  console.warn('[sync-db-schema] 警告：SKIP_DB_PUSH=1 已設定，跳過 npx prisma db push --skip-generate');
  process.exit(0);
}

runStep('npx prisma db push --skip-generate', 'prisma db push --skip-generate');
console.log('[sync-db-schema] 資料庫結構同步完成。');
