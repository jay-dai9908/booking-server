import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..');

const SCHEMA_PATH = path.join(BACKEND_ROOT, 'prisma', 'schema.prisma');
const ENSURE_SCHEMA_PATH = path.join(BACKEND_ROOT, 'src', 'db', 'ensureSchema.js');

/**
 * Baseline models, columns, and indexes established by the very first `prisma db push`
 * before `ensureDatabaseSchema()` was introduced.
 * NEVER add post-baseline (Round 9+, Round 30-47, GlobalSetting.business_hours_json /
 * booking_note_chips / guest_line_hint_text, BoardPause, BookingEquipment indexes,
 * Payment.client_batch_id index, etc.) to this whitelist!
 */
const BASELINE_TABLES = new Set([
  'User',
  'Session',
  'Reservation',
  'DailySetting',
  'GlobalSetting',
  'BannedIP',
  'AdminUser',
  'EquipmentConfig',
  'BookingEquipment',
  'PassPlan',
  'UserPass',
  'DailySeq',
  'CashClosing',
  'BookingPerson',
  'TimerPause',
  'Payment',
  'AccountingEvent',
  'PrintJob',
  'KioskDevice',
  'KioskSetting',
  'KioskEntryLog',
  'KioskAlertState'
]);

const BASELINE_COLUMNS = {
  User: new Set(['id', 'line_user_id', 'name', 'phone', 'created_at']),
  Session: new Set(['id', 'session_date', 'start_time', 'end_time', 'max_capacity']),
  Reservation: new Set([
    'id', 'booking_ref', 'session_id', 'user_id', 'pax', 'status', 'created_at',
    'attendance', 'checked_in_at', 'assigned_seats', 'is_seat_locked', 'is_force_split',
    'is_unlimited', 'is_walk_in', 'is_paid', 'total_amount', 'is_amount_manual',
    'paid_at', 'payment_method', 'cancelled_at', 'cancelled_by'
  ]),
  DailySetting: new Set(['id', 'date', 'allow_unlimited', 'hourly_price', 'unlimited_price']),
  GlobalSetting: new Set([
    'id', 'weekday_hourly_price', 'weekday_unlimited_price',
    'weekend_hourly_price', 'weekend_unlimited_price', 'is_lockdown_mode'
  ]),
  BannedIP: new Set(['id', 'ip', 'reason', 'banned_at']),
  AdminUser: new Set(['id', 'name', 'password', 'role', 'permissions', 'is_active', 'created_at']),
  EquipmentConfig: new Set([
    'id', 'name', 'visibility_status', 'status_note', 'total_stock', 'hourly_rate',
    'daily_cap', 'min_contiguous_hours', 'allow_exceed_pax', 'sort_order', 'created_at'
  ]),
  BookingEquipment: new Set([
    'id', 'booking_ref', 'equipment_id', 'equipment_name_snapshot',
    'quantity', 'rental_hours', 'subtotal_price', 'covered_sessions', 'created_at'
  ]),
  PassPlan: new Set([
    'id', 'code', 'name', 'pass_type', 'price', 'total_quota', 'description',
    'max_hours_per_day', 'max_days_per_week', 'max_hours_per_week', 'valid_days',
    'day_restriction', 'is_active', 'discount_percent', 'is_purchasable_online', 'created_at'
  ]),
  UserPass: new Set([
    'id', 'pass_code', 'user_id', 'plan_id', 'plan_name_snapshot', 'pass_type',
    'remaining_quota', 'total_quota', 'day_restriction', 'max_hours_per_day',
    'max_days_per_week', 'max_hours_per_week', 'payment_status', 'order_ref',
    'expires_at', 'status', 'usage_logs_json', 'notes', 'created_at'
  ]),
  DailySeq: new Set(['seq_date', 'seq_type', 'last_seq']),
  CashClosing: new Set([
    'id', 'business_date', 'shift_no', 'period_start_at', 'period_end_at',
    'float_amount', 'expected_cash', 'counted_cash', 'handed_over_amount',
    'left_in_drawer', 'difference', 'totals_json', 'note', 'staff_name',
    'device_label', 'created_at'
  ]),
  BookingPerson: new Set([
    'id', 'booking_ref', 'person_no', 'seat_code', 'status', 'is_onsite_added',
    'billing_start_at', 'timer_started_at', 'timer_ended_at', 'paused_at',
    'paused_seconds', 'created_by_name', 'created_at', 'updated_at'
  ]),
  TimerPause: new Set(['id', 'person_id', 'started_at', 'ended_at', 'reason', 'staff_name']),
  Payment: new Set([
    'id', 'payment_no', 'batch_no', 'client_batch_id', 'booking_ref', 'source', 'source_ref',
    'kind', 'status', 'method', 'amount', 'waived_amount', 'cash_received', 'change_given',
    'person_nos', 'breakdown_json', 'pass_json', 'related_payment_id', 'reason', 'note',
    'staff_name', 'staff_id', 'device_id', 'device_label', 'receipt_status', 'created_at',
    'voided_at', 'voided_by_name', 'void_reason'
  ]),
  AccountingEvent: new Set([
    'id', 'booking_ref', 'event_type', 'category', 'summary', 'amount',
    'before_json', 'after_json', 'payment_id', 'print_job_id', 'reason',
    'staff_name', 'staff_id', 'device_id', 'device_label', 'created_at'
  ]),
  PrintJob: new Set([
    'id', 'job_no', 'type', 'booking_ref', 'payment_id', 'closing_id', 'payload_json',
    'status', 'is_reprint', 'claimed_by_device', 'claimed_at', 'lease_until',
    'printed_at', 'error_code', 'error_message', 'retry_count', 'created_at'
  ])
};

const BASELINE_INDEXES = new Set([
  'User:unique:line_user_id',
  'Session:unique:session_date,start_time',
  'DailySetting:unique:date',
  'BannedIP:unique:ip',
  'AdminUser:unique:password',
  'PassPlan:unique:code',
  'UserPass:unique:pass_code',
  'UserPass:index:user_id,status',
  'UserPass:index:pass_code',
  'DailySeq:unique:seq_date,seq_type',
  'CashClosing:index:business_date',
  'BookingPerson:unique:booking_ref,person_no',
  'BookingPerson:index:booking_ref',
  'Payment:unique:payment_no',
  'Payment:index:booking_ref',
  'Payment:index:created_at',
  'Payment:index:batch_no',
  'Payment:index:source,created_at',
  'AccountingEvent:index:booking_ref',
  'AccountingEvent:index:created_at',
  'AccountingEvent:index:event_type',
  'PrintJob:unique:job_no',
  'PrintJob:index:status,created_at'
]);

function parsePrismaSchema(src) {
  const modelNames = new Set();
  const modelBlocks = [];
  const blockRegex = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = blockRegex.exec(src)) !== null) {
    modelNames.add(m[1]);
    modelBlocks.push({ name: m[1], body: m[2] });
  }

  const models = [];
  for (const { name, body } of modelBlocks) {
    const columns = [];
    const uniques = [];
    const indexes = [];
    const mapField = new Map();

    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/\/\/.*$/, '').trim();
      if (!line) continue;

      if (line.startsWith('@@unique')) {
        const match = line.match(/@@unique\s*\(\s*\[([^\]]+)\]/);
        if (match) {
          const cols = match[1].split(',').map((s) => s.trim());
          uniques.push(cols);
        }
        continue;
      }
      if (line.startsWith('@@index')) {
        const match = line.match(/@@index\s*\(\s*\[([^\]]+)\]/);
        if (match) {
          const cols = match[1].split(',').map((s) => s.trim());
          indexes.push(cols);
        }
        continue;
      }
      if (line.startsWith('@@')) continue;

      const fieldMatch = line.match(/^(\w+)\s+(\S+)(.*)$/);
      if (!fieldMatch) continue;
      const [, fieldName, rawType, rest] = fieldMatch;
      const baseType = rawType.replace(/[?\[\]]/g, '');
      if (modelNames.has(baseType)) continue; // relation field
      if (rest.includes('@relation')) continue;

      const dbColMatch = rest.match(/@map\(\s*"([^"]+)"\s*\)/);
      const colName = dbColMatch ? dbColMatch[1] : fieldName;
      mapField.set(fieldName, colName);
      columns.push(colName);

      if (rest.includes('@unique')) {
        uniques.push([colName]);
      }
    }

    models.push({
      name,
      columns,
      uniques: uniques.map((cols) => cols.map((c) => mapField.get(c) || c)),
      indexes: indexes.map((cols) => cols.map((c) => mapField.get(c) || c))
    });
  }
  return models;
}

function parseEnsureSchemaSql(src) {
  const tables = new Set();
  const columns = new Map(); // table -> Set(col)
  const indexSignatures = new Set(); // `${table}:${isUnique ? 'unique' : 'index'}:${cols.join(',')}`
  const indexNames = new Set();

  const ensureColSet = (table) => {
    if (!columns.has(table)) columns.set(table, new Set());
    return columns.get(table);
  };

  // Match backtick or single-quoted SQL statements inside ensureSchema.js
  const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s*\(([\s\S]*?)\)\s*`/gi;
  let tm;
  while ((tm = createTableRegex.exec(src)) !== null) {
    const table = tm[1];
    const inner = tm[2];
    tables.add(table);
    const colSet = ensureColSet(table);
    for (const rawLine of inner.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed || /^(?:CONSTRAINT|PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY)\b/i.test(trimmed)) {
        const uqMatch = trimmed.match(/UNIQUE\s*\(([^)]+)\)/i);
        if (uqMatch) {
          const cols = uqMatch[1].split(',').map((s) => s.replace(/["`\s]/g, ''));
          indexSignatures.add(`${table}:unique:${cols.join(',')}`);
        }
        continue;
      }
      const cm = trimmed.match(/^"([^"]+)"\s+/);
      if (cm) colSet.add(cm[1]);
    }
  }

  const alterColRegex = /ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi;
  let am;
  while ((am = alterColRegex.exec(src)) !== null) {
    ensureColSet(am[1]).add(am[2]);
  }

  const indexRegex = /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s+ON\s+"([^"]+)"\s*\(([^)]+)\)/gi;
  let im;
  while ((im = indexRegex.exec(src)) !== null) {
    const isUnique = Boolean(im[1]);
    const idxName = im[2];
    const table = im[3];
    const cols = im[4].split(',').map((s) => s.replace(/["`\s]/g, '').replace(/(ASC|DESC)$/i, ''));
    indexNames.add(idxName);
    indexSignatures.add(`${table}:${isUnique ? 'unique' : 'index'}:${cols.join(',')}`);
  }

  return { tables, columns, indexSignatures, indexNames };
}

test('Round 46 Item 5: ensureSchema.js covers every model, column, unique, and index in schema.prisma (no network/DB)', () => {
  const schemaSrc = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const ensureSrc = fs.readFileSync(ENSURE_SCHEMA_PATH, 'utf8');

  const models = parsePrismaSchema(schemaSrc);
  const ensured = parseEnsureSchemaSql(ensureSrc);

  const missing = [];

  for (const model of models) {
    const hasTable = ensured.tables.has(model.name) || BASELINE_TABLES.has(model.name);
    if (!hasTable) {
      missing.push(`Missing CREATE TABLE "${model.name}"`);
    }

    const ensuredCols = ensured.columns.get(model.name) || new Set();
    const baseCols = BASELINE_COLUMNS[model.name] || new Set();
    for (const col of model.columns) {
      if (!ensuredCols.has(col) && !baseCols.has(col)) {
        missing.push(`Missing column "${model.name}"."${col}"`);
      }
    }

    for (const uCols of model.uniques) {
      const sig = `${model.name}:unique:${uCols.join(',')}`;
      const expectedIdxName = `${model.name}_${uCols.join('_')}_key`;
      if (!ensured.indexSignatures.has(sig) && !ensured.indexNames.has(expectedIdxName) && !BASELINE_INDEXES.has(sig)) {
        missing.push(`Missing UNIQUE index on "${model.name}"(${uCols.join(', ')}) [${expectedIdxName}]`);
      }
    }

    for (const iCols of model.indexes) {
      const sig = `${model.name}:index:${iCols.join(',')}`;
      const expectedIdxName = `${model.name}_${iCols.join('_')}_idx`;
      if (!ensured.indexSignatures.has(sig) && !ensured.indexNames.has(expectedIdxName) && !BASELINE_INDEXES.has(sig)) {
        missing.push(`Missing INDEX on "${model.name}"(${iCols.join(', ')}) [${expectedIdxName}]`);
      }
    }
  }

  assert.equal(
    missing.length,
    0,
    `schema.prisma 與 ensureSchema.js 結構不一致（共 ${missing.length} 項）：\n- ${missing.join('\n- ')}`
  );
});
