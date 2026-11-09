import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getGuestLineAction } from '../src/utils/lineAuth.js';

describe('getGuestLineAction unit tests', () => {
  const lineUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 Line/13.4.1';
  const instagramUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 270.0.0.0';
  const facebookUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/410.0.0;]';
  const threadsUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Barcelona 300.0.0';
  const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const safariUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

  test('LINE UA returns login for both home and preview to prevent redirect loops', () => {
    assert.equal(getGuestLineAction('home', lineUA), 'login');
    assert.equal(getGuestLineAction('preview', lineUA), 'login');
    assert.equal(getGuestLineAction('/', lineUA), 'login');
    assert.equal(getGuestLineAction('/preview', lineUA), 'login');
  });

  test('Instagram UA returns oa for both home and preview', () => {
    assert.equal(getGuestLineAction('home', instagramUA), 'oa');
    assert.equal(getGuestLineAction('preview', instagramUA), 'oa');
  });

  test('Facebook & Threads UA returns oa for both home and preview', () => {
    assert.equal(getGuestLineAction('home', facebookUA), 'oa');
    assert.equal(getGuestLineAction('preview', facebookUA), 'oa');
    assert.equal(getGuestLineAction('home', threadsUA), 'oa');
    assert.equal(getGuestLineAction('preview', threadsUA), 'oa');
  });

  test('Standard Chrome & Safari UA returns login for home and oa for preview', () => {
    assert.equal(getGuestLineAction('home', chromeUA), 'login');
    assert.equal(getGuestLineAction('preview', chromeUA), 'oa');
    assert.equal(getGuestLineAction('home', safariUA), 'login');
    assert.equal(getGuestLineAction('preview', safariUA), 'oa');
  });
});
