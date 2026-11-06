import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendSrc = path.resolve(__dirname, '../src');

function getAllFiles(dir, predicate) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllFiles(fullPath, predicate));
    } else if (predicate(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

test('all controllers, services, routes, and utils can be imported without ERR_MODULE_NOT_FOUND', async (t) => {
  const dirsToTest = [
    path.join(backendSrc, 'controllers'),
    path.join(backendSrc, 'services'),
    path.join(backendSrc, 'routes'),
    path.join(backendSrc, 'utils')
  ];

  const files = [];
  for (const dir of dirsToTest) {
    if (fs.existsSync(dir)) {
      files.push(...getAllFiles(dir, (f) => f.endsWith('.js')));
    }
  }

  assert.ok(files.length > 0, 'Found backend js files to test');

  for (const file of files) {
    const relativeName = path.relative(backendSrc, file);
    await t.test(`import src/${relativeName}`, async () => {
      const fileUrl = pathToFileURL(file).href;
      const mod = await import(fileUrl);
      assert.ok(mod !== null && typeof mod === 'object');
    });
  }
});
