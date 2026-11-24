import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const scriptPath = path.resolve(__dirname, '../scripts/check-secrets.mjs');

function runCheckSecretsOnDir(dirPath) {
  return spawnSync(process.execPath, [scriptPath, '--dir', dirPath], {
    encoding: 'utf8'
  });
}

function withTempDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-secrets-test-'));
  try {
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('Rule 1: src file with TW mobile number triggers violation without printing phone content', () => {
  withTempDir((tmpDir) => {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const samplePhone = ['0912', '345', '678'].join('-');
    fs.writeFileSync(
      path.join(srcDir, 'sample.js'),
      `const x = 1;\nconst phone = '${samplePhone}';\n`,
      'utf8'
    );

    const res = runCheckSecretsOnDir(tmpDir);
    const combinedOutput = `${res.stdout || ''}\n${res.stderr || ''}`;
    assert.notStrictEqual(res.status, 0, 'Expected non-zero exit code for hardcoded phone in src');
    assert.ok(combinedOutput.includes('src/sample.js:2'), `Expected filename and line number in output, got: ${combinedOutput}`);
    assert.ok(!combinedOutput.includes(samplePhone), 'Output must NEVER include the offending phone number literal');
  });
});

test('Rule 2: LINE user ID U + 32 hex chars triggers violation everywhere (even with fake-data comment)', () => {
  withTempDir((tmpDir) => {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const fakeLineId = 'U' + 'a1b2c3d4'.repeat(4);
    fs.writeFileSync(
      path.join(srcDir, 'line.js'),
      `const uid = '${fakeLineId}'; // check-secrets: fake-data\n`,
      'utf8'
    );

    const res = runCheckSecretsOnDir(tmpDir);
    const combinedOutput = `${res.stdout || ''}\n${res.stderr || ''}`;
    assert.notStrictEqual(res.status, 0, 'Expected non-zero exit code for LINE user ID');
    assert.ok(combinedOutput.includes('src/line.js:1'), `Expected src/line.js:1 in output, got: ${combinedOutput}`);
    assert.ok(!combinedOutput.includes(fakeLineId), 'Output must not leak the LINE user ID literal');
  });
});

test('Rule 3: 6 lines of "name 13~15 2" booking format triggers violation, while 3 lines pass', () => {
  withTempDir((tmpDir) => {
    const sixLines = [
      'Alice 13~15 2',
      'Bob 14~16 3',
      'Carol 15~17 2',
      'Dave 16~18 4',
      'Eve 17~19 1',
      'Frank 18~20 2'
    ].join('\n');
    const filePath = path.join(tmpDir, 'paste.js');
    fs.writeFileSync(filePath, `const raw = \`\n${sixLines}\n\`;\n`, 'utf8');

    const res6 = runCheckSecretsOnDir(tmpDir);
    assert.notStrictEqual(res6.status, 0, 'Expected 6 raw booking lines to fail check-secrets');

    const threeLines = [
      'Alice 13~15 2',
      'Bob 14~16 3',
      'Carol 15~17 2'
    ].join('\n');
    fs.writeFileSync(filePath, `const raw = \`\n${threeLines}\n\`;\n`, 'utf8');

    const res3 = runCheckSecretsOnDir(tmpDir);
    assert.strictEqual(res3.status, 0, `Expected 3 raw booking lines to pass check-secrets, stderr: ${res3.stderr}`);
  });
});

test('Rule 4: name literal + ISO date on same line fails, and passes with // check-secrets: fake-data', () => {
  withTempDir((tmpDir) => {
    const filePath = path.join(tmpDir, 'check.js');
    const targetLine = "if (r.user.name === 'Amy' && date === '2026-01-01') {}";
    fs.writeFileSync(filePath, `${targetLine}\n`, 'utf8');

    const resFail = runCheckSecretsOnDir(tmpDir);
    assert.notStrictEqual(resFail.status, 0, 'Expected name + date on same line to trigger violation');
    assert.ok(!(resFail.stderr || '').includes('Amy'), 'Output must not print the customer name');

    fs.writeFileSync(filePath, `${targetLine} // check-secrets: fake-data\n`, 'utf8');
    const resPass = runCheckSecretsOnDir(tmpDir);
    assert.strictEqual(resPass.status, 0, `Expected // check-secrets: fake-data to exempt Rule 4, stderr: ${resPass.stderr}`);
  });
});

test('Rule 5: normal code such as /^09\\d{8}$/ regex passes cleanly', () => {
  withTempDir((tmpDir) => {
    const filePath = path.join(tmpDir, 'validator.js');
    fs.writeFileSync(
      filePath,
      'export const isPhone = (v) => /^09\\d{8}$/.test(v);\n',
      'utf8'
    );

    const res = runCheckSecretsOnDir(tmpDir);
    assert.strictEqual(res.status, 0, `Expected normal regex code to pass, stderr: ${res.stderr}`);
  });
});
