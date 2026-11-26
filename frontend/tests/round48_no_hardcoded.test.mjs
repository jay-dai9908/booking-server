import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_ROOT = path.resolve(__dirname, '../src');

function walkFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (/\.(js|jsx|mjs)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

test('Round 48 Item 1: frontend/src contains no hardcoded fake bank account or non-existent payment_method !== check', () => {
  const files = walkFiles(SRC_ROOT);
  const forbiddenFakeAccount = '9012 ' + '3456';
  const forbiddenFieldCheck = 'payment_method !' + '==';

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(
      content.includes(forbiddenFakeAccount),
      false,
      `${path.relative(SRC_ROOT, file)} must not contain hardcoded fake account`
    );
    assert.equal(
      content.includes(forbiddenFieldCheck),
      false,
      `${path.relative(SRC_ROOT, file)} must not check non-existent payment_method field`
    );
  }
});
