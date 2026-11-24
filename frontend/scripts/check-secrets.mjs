import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'prisma']);
const SCAN_EXT_REGEX = /\.(js|mjs|cjs|ts|jsx|tsx|md|json|sql)$/i;

// Parse optional --dir <path> CLI arguments
const args = process.argv.slice(2);
const customDirs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dir' && args[i + 1]) {
    customDirs.push(path.resolve(args[i + 1]));
    i++;
  }
}

const defaultScanTargets = [
  { dir: path.join(rootDir, 'backend'), recursive: false },
  { dir: path.join(rootDir, 'backend', 'src'), recursive: true },
  { dir: path.join(rootDir, 'backend', 'scripts'), recursive: true },
  { dir: path.join(rootDir, 'backend', 'test'), recursive: true },
  { dir: path.join(rootDir, 'frontend', 'src'), recursive: true },
  { dir: path.join(rootDir, 'frontend', 'tests'), recursive: true },
  { dir: path.join(rootDir, 'frontend', 'scripts'), recursive: true },
  { dir: path.join(rootDir, 'shared'), recursive: true },
  { dir: path.join(rootDir, 'docs'), recursive: true }
];

const scanTargets = customDirs.length > 0
  ? customDirs.map((d) => ({ dir: d, recursive: true }))
  : defaultScanTargets;

const FORBIDDEN_PATTERNS = [
  { name: 'ADMIN_PASSWORD ||', regex: /(?<![!])\bADMIN_PASSWORD\s*\|\|/ },
  { name: 'JWT_SECRET ||', regex: /(?<![!])\bJWT_SECRET\s*\|\|/ },
  { name: 'super_secret', regex: /super_secret/i },
  { name: 'Hardcoded Windows user path (C:\\Users\\)', regex: /C:\\+Users\\+/i },
  { name: 'Hardcoded Unix user path (/Users/)', regex: /\/Users\// }
];

// SHA-256 hashes of known leaked credentials (never commit plaintext secrets)
const FORBIDDEN_SECRET_HASHES = new Set([
  'b19e5bcbd873e1b35f5abc3179a765126bbf71a1c6bbe7251d18a0ea0fe76e35'
]);

const FAKE_DATA_MARKER_REGEX = /\/\/\s*check-secrets:\s*fake-data\b/;
const TW_PHONE_REGEX = /\b09\d{2}-?\d{3}-?\d{3}\b/;
const LINE_USER_ID_REGEX = /\bU[0-9a-f]{32}\b/;
const BOOKING_TIME_RANGE_REGEX = /(?:^|[^\d-])\d{1,2}(?::\d{2})?\s*[~～\-]\s*\d{1,2}(?::\d{2})?(?!-\d)/;
const BOOKING_TRAILING_PAX_REGEX = /\s+\d+\s*$/;
const NAME_LITERAL_REGEX = /\bname\s*(?:===|:)\s*['"][^'"]+['"]/;
const USER_NAME_EQ_REGEX = /\buser\.name\s*===\s*['"][^'"]+['"]/;
const ISO_DATE_REGEX = /\b20\d{2}-\d{2}-\d{2}\b/;

function collectFiles(dir, recursive = true, files = []) {
  if (!fs.existsSync(dir)) return files;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    files.push(dir);
    return files;
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        collectFiles(fullPath, true, files);
      }
    } else if (entry.isFile()) {
      if (entry.name === 'package-lock.json') continue;
      if (!SCAN_EXT_REGEX.test(entry.name)) continue;
      if (path.resolve(fullPath) === path.resolve(__filename)) continue;
      files.push(fullPath);
    }
  }
  return files;
}

function isTestContextFile(filePath) {
  const norm = filePath.replace(/\\/g, '/');
  if (customDirs.length > 0) {
    for (const cd of customDirs) {
      const rel = path.relative(cd, filePath).replace(/\\/g, '/');
      if (/^(test|tests)(\/|$)/.test(rel) || /\/(test|tests)(\/|$)/.test(rel)) {
        return true;
      }
    }
    return false;
  }
  const relRepo = path.relative(rootDir, filePath).replace(/\\/g, '/');
  if (
    relRepo.startsWith('backend/test/') ||
    relRepo.startsWith('frontend/tests/') ||
    relRepo.startsWith('frontend/scripts/') ||
    relRepo === 'docs/kiosk-vectors.json'
  ) {
    return true;
  }
  return false;
}

function formatDisplayPath(filePath) {
  if (customDirs.length > 0) {
    for (const cd of customDirs) {
      if (filePath.startsWith(cd)) {
        return path.relative(cd, filePath).replace(/\\/g, '/');
      }
    }
  }
  return path.relative(rootDir, filePath).replace(/\\/g, '/');
}

function isRawBookingPasteLine(line) {
  const stripped = line.replace(/\/\/.*$/, '').trim();
  if (!stripped) return false;
  return BOOKING_TIME_RANGE_REGEX.test(stripped) && BOOKING_TRAILING_PAX_REGEX.test(stripped);
}

let violations = 0;
const seenFiles = new Set();

for (const target of scanTargets) {
  const files = collectFiles(target.dir, target.recursive);
  for (const file of files) {
    const resolved = path.resolve(file);
    if (seenFiles.has(resolved)) continue;
    seenFiles.add(resolved);

    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/);
    const isTest = isTestContextFile(file);
    const displayPath = formatDisplayPath(file);
    const rawBookingLines = [];

    lines.forEach((line, idx) => {
      const lineNo = idx + 1;
      const isFakeDataExempt = FAKE_DATA_MARKER_REGEX.test(line);

      for (const { name, regex } of FORBIDDEN_PATTERNS) {
        if (regex.test(line)) {
          console.error(`[check-secrets] FORBIDDEN SECRET PATTERN "${name}" found in ${displayPath}:${lineNo}`);
          violations++;
        }
      }

      // Check SHA-256 hashes of string literals
      const stringMatches = line.match(/(['"`])(.*?)\1/g) || [];
      for (const rawMatch of stringMatches) {
        const val = rawMatch.slice(1, -1);
        if (val.length >= 8) {
          const hash = crypto.createHash('sha256').update(val).digest('hex');
          if (FORBIDDEN_SECRET_HASHES.has(hash)) {
            console.error(`[check-secrets] FORBIDDEN SECRET HASH MATCH found in ${displayPath}:${lineNo}`);
            violations++;
          }
        }
      }

      // Customer PII Rule 1: Taiwan mobile number in non-test files
      if (!isTest && !isFakeDataExempt && TW_PHONE_REGEX.test(line)) {
        console.error(`[check-secrets] SUSPICIOUS CUSTOMER DATA "Taiwan mobile number" found in ${displayPath}:${lineNo}`);
        violations++;
      }

      // Customer PII Rule 2: LINE user ID U[0-9a-f]{32} (anywhere, never exempt)
      if (LINE_USER_ID_REGEX.test(line)) {
        console.error(`[check-secrets] SUSPICIOUS CUSTOMER DATA "LINE user ID" found in ${displayPath}:${lineNo}`);
        violations++;
      }

      // Customer PII Rule 3 candidate: raw booking line (name + time range + trailing pax)
      if (!isFakeDataExempt && isRawBookingPasteLine(line)) {
        rawBookingLines.push(lineNo);
      }

      // Customer PII Rule 4: name literal + YYYY-MM-DD date on same line (or user.name === '<literal>') in non-test files
      if (!isTest && !isFakeDataExempt) {
        if ((NAME_LITERAL_REGEX.test(line) && ISO_DATE_REGEX.test(line)) || USER_NAME_EQ_REGEX.test(line)) {
          console.error(`[check-secrets] SUSPICIOUS CUSTOMER DATA "Hardcoded customer name" found in ${displayPath}:${lineNo}`);
          violations++;
        }
      }
    });

    if (rawBookingLines.length >= 5) {
      for (const lineNo of rawBookingLines) {
        console.error(`[check-secrets] SUSPICIOUS CUSTOMER DATA "Raw booking text paste (>=5 lines)" found in ${displayPath}:${lineNo}`);
        violations++;
      }
    }
  }
}

if (violations > 0) {
  console.error(`\n[check-secrets] FAILED: ${violations} forbidden secret/PII pattern(s) detected.`);
  process.exit(1);
} else {
  console.log('✔ check-secrets: No hardcoded secrets or customer PII found.');
}
