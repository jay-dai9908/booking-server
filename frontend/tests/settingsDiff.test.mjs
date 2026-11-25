import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSettings } from '../src/utils/admin/settingsDiff.js';

test('diffSettings returns only changed primitive fields', () => {
  const saved = { a: 1, b: 'x', chips: ['A'] };
  const draft = { a: 1, b: 'y', chips: ['A'] };
  assert.deepEqual(diffSettings(saved, draft), { b: 'y' });
});

test('diffSettings detects array content changes and nested object equality', () => {
  const saved = {
    a: 1,
    chips: ['A'],
    hours: { weekday: { start: '10:00', end: '21:00' } },
    methods: [{ key: 'cash', label: '現金', enabled: true }]
  };
  const draftUnchanged = {
    a: 1,
    chips: ['A'],
    hours: { weekday: { end: '21:00', start: '10:00' } },
    methods: [{ key: 'cash', label: '現金', enabled: true }]
  };
  assert.deepEqual(diffSettings(saved, draftUnchanged), {});

  const draftChanged = {
    ...draftUnchanged,
    chips: ['A', 'B']
  };
  assert.deepEqual(diffSettings(saved, draftChanged), { chips: ['A', 'B'] });
});

test('diffSettings normalizes numeric strings vs numbers while preserving empty string vs zero difference', () => {
  assert.deepEqual(diffSettings({ price: 100 }, { price: '100' }), {});
  assert.deepEqual(diffSettings({ grace: 0 }, { grace: '0' }), {});
  assert.deepEqual(diffSettings({ grace: 0 }, { grace: '' }), { grace: '' });
  assert.deepEqual(diffSettings({ price: 100 }, { price: '120' }), { price: '120' });
});
