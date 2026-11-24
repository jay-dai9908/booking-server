import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, '..');
const testDir = path.join(backendDir, 'test');

const testFiles = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join('test', name));

if (testFiles.length === 0) {
  console.error('[run-tests] No *.test.js files found in', testDir);
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ['--test', '--test-concurrency=1', ...testFiles],
  {
    cwd: backendDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TZ: process.env.TZ || 'Asia/Taipei'
    },
    stdio: 'inherit'
  }
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
