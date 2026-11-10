import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

const scanDirs = [
  path.join(rootDir, 'frontend', 'tests'),
  path.join(rootDir, 'backend', 'test'),
  path.join(rootDir, 'frontend', 'scripts')
];

const FORBIDDEN_PATTERNS = [
  { name: 'ADMIN_PASSWORD ||', regex: /ADMIN_PASSWORD\s*\|\|/ },
  { name: 'JWT_SECRET ||', regex: /JWT_SECRET\s*\|\|/ },
  { name: 'gathering.light2609', regex: /gathering\.light2609/ },
  { name: 'super_secret', regex: /super_secret/i }
];

function getAllFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      getAllFiles(fullPath, files);
    } else if (entry.isFile() && /\.(js|mjs|cjs|ts|jsx|tsx)$/.test(entry.name)) {
      if (path.resolve(fullPath) === path.resolve(__filename)) continue;
      files.push(fullPath);
    }
  }
  return files;
}

let violations = 0;

for (const dir of scanDirs) {
  const files = getAllFiles(dir);
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      for (const { name, regex } of FORBIDDEN_PATTERNS) {
        if (regex.test(line)) {
          console.error(`[check-secrets] FORBIDDEN SECRET PATTERN "${name}" found in ${path.relative(rootDir, file)}:${idx + 1}`);
          console.error(`  Line ${idx + 1}: ${line.trim()}`);
          violations++;
        }
      }
    });
  }
}

if (violations > 0) {
  console.error(`\n[check-secrets] FAILED: ${violations} forbidden secret pattern(s) detected.`);
  process.exit(1);
} else {
  console.log('✔ check-secrets: No hardcoded secrets or fallbacks found in test files.');
}
