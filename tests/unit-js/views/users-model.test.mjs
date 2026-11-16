// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure helpers of the Users screens: login and password rules, the matrix model (cap and filter), grant levels,
// lock-out guards and the reading of `GET effective`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MATRIX_MAX_COLUMNS, adminCount, buildMatrix, checkDisplayName, checkLogin, checkPassword, dateText, effectiveRows, filterAccounts, guardFor, levelOf, nameOfHref, ownerOfHref, parseLevel, reachableCount, sameHref, strength,
} from '../../../src/js/views/users/model.js';
import { acct, coll } from './users-helpers.mjs';

test('checkLogin mirrors the service: pattern, reserved names, radui- prefix', () => {
  assert.equal(checkLogin(''), 'required');
  for (const bad of ['A', 'Bob', 'a', '-bob', 'bob smith', 'x'.repeat(33), 'bob/../x']) assert.equal(checkLogin(bad), 'pattern', bad);
  for (const r of ['root', 'admin', 'radicale', 'ui', 'api', 'web', 'sharing', 'system', 'radui-x']) assert.equal(checkLogin(r), 'reserved', r);
  for (const ok of ['bob', 'agent-1', 'a.b_c-d', '0day', 'x'.repeat(32)]) assert.equal(checkLogin(ok), null, ok);
});

test('checkDisplayName: required, 64 characters, no hidden characters', () => {
  assert.equal(checkDisplayName('  '), 'required');
  assert.equal(checkDisplayName('a'.repeat(65)), 'long');
  assert.equal(checkDisplayName('Bob‮evil'), 'control');
  assert.equal(checkDisplayName('Bob Example'), null);
});

test('checkPassword: 12 to 72 bytes, not the login, three classes below 16 characters', () => {
  assert.equal(checkPassword(''), 'required');
  assert.equal(checkPassword('Short1!'), 'short');
  assert.equal(checkPassword('A'.repeat(40) + 'é'.repeat(20)), 'long');
  assert.equal(checkPassword('xxBobxxxxxxxxxx1A', 'bob'), 'login');
  assert.equal(checkPassword('alllowercaseonly'.slice(0, 12)), 'weak');
  assert.equal(checkPassword('alllowercaseonlyletters'), null, '16 characters or more need no classes');
  assert.equal(checkPassword('Mixed-Case-12'), null);
});

test('strength: 0..4, never above 1 under 12 characters or with the login inside', () => {
  assert.ok(strength('abc') <= 1);
  assert.equal(strength('aaaaaaaaaaaaaaaa'), 0);
  assert.ok(strength('Tr0ub4dor&3-xyzzy-long') >= 3);
  assert.ok(strength('Tr0ub4dor&3-bob-long', 'bob') <= 1);
});

test('hrefs and levels', () => {
  assert.equal(ownerOfHref('/alice/work/'), 'alice');
  assert.equal(nameOfHref('/alice/work/'), 'work');
  assert.equal(nameOfHref('/alice/a%20b/'), 'a b');
  assert.equal(sameHref('/alice/work/', '/alice/work'), true);
  assert.equal(sameHref('/alice/work/', '/alice/other/'), false);
  const grants = [{ owner: 'alice', collection: 'work', grantee: 'bob', level: 'read' }, { owner: 'alice', collection: 'work', grantee: 'carol', level: 'readwrite' }];
  assert.equal(levelOf(grants, 'alice', 'work', 'bob'), 'read');
  assert.equal(levelOf(grants, 'alice', 'work', 'carol'), 'readwrite');
  assert.equal(levelOf(grants, 'alice', 'work', 'dave'), 'none');
  assert.equal(levelOf(grants, 'alice', 'other', 'bob'), 'none');
  assert.deepEqual(['none', 'read', 'readwrite', 'r', 'rw', 'RW', 'x', ''].map(parseLevel), ['none', 'read', 'readwrite', 'read', 'readwrite', 'readwrite', null, null]);
});

test('guardFor: yourself and the last administrator are locked', () => {
  const accounts = [acct('alice', { admin: true }), acct('bob', { admin: true }), acct('carol')];
  assert.deepEqual(guardFor(accounts[0], accounts, 'alice'), { self: true, lastAdmin: false, locked: true, reason: 'self' });
  assert.equal(guardFor(accounts[1], accounts, 'alice').locked, false);
  assert.equal(guardFor(accounts[2], accounts, 'alice').locked, false);
  const lone = [acct('alice', { admin: true }), acct('carol')];
  assert.deepEqual(guardFor(lone[0], lone, 'bob'), { self: false, lastAdmin: true, locked: true, reason: 'lastAdmin' });
  assert.equal(adminCount([acct('x', { admin: true, disabled: true }), acct('y')]), 0);
});

test('filterAccounts: login or display name, case-insensitive', () => {
  const list = [acct('alice'), acct('bob', { displayName: 'Robert Example' }), acct('agent-1')];
  assert.deepEqual(filterAccounts(list, 'ROB').map((a) => a.login), ['bob']);
  assert.deepEqual(filterAccounts(list, 'ag').map((a) => a.login), ['agent-1']);
  assert.equal(filterAccounts(list, '  ').length, 3);
});

test('buildMatrix: enabled non-admin columns, capped at 12 with a filter, rows sorted owner/name', () => {
  const accounts = [acct('alice', { admin: true }), acct('off', { disabled: true })];
  for (let i = 1; i <= 15; i++) accounts.push(acct(`u${String(i).padStart(2, '0')}`));
  const collectionsByOwner = { u02: [coll('/u02/zeta/'), coll('/u02/alpha/')], alice: [coll('/alice/work/')] };
  const m = buildMatrix({ accounts, collectionsByOwner });
  assert.equal(m.columns.length, MATRIX_MAX_COLUMNS);
  assert.equal(m.totalColumns, 15);
  assert.equal(m.hiddenColumns, 3);
  assert.equal(m.columns.some((a) => a.login === 'alice' || a.login === 'off'), false, 'admins and disabled accounts are not columns');
  assert.deepEqual(m.rows.map((r) => r.path), ['alice/work', 'u02/alpha', 'u02/zeta']);
  const f = buildMatrix({ accounts, collectionsByOwner, filter: 'u1' });
  assert.deepEqual(f.columns.map((a) => a.login), ['u10', 'u11', 'u12', 'u13', 'u14', 'u15']);
  assert.equal(f.hiddenColumns, 0);
  assert.equal(buildMatrix({ accounts, collectionsByOwner, filter: 'zzz' }).columns.length, 0);
});

test('effectiveRows keeps collection-level answers and drops the root, principals and the probe path', () => {
  const rows = effectiveRows([
    { path: '/', level: 'root', letters: 'R' },
    { path: '/bob', level: 'principal', letters: 'RW' },
    { path: '/bob/*', level: 'own', letters: 'rwDO' },
    { path: '/alice/work', level: 'grant-r', letters: 'r' },
    { path: '/alice/team', level: 'grant-rw', letters: 'rwl' },
    { path: '/carol/*', level: 'none', letters: '' },
    { path: '/radui-probe-top', level: 'none', letters: '' },
    { nope: 1 },
  ]);
  assert.deepEqual(rows.map((r) => [r.path, r.why, r.canView, r.canChange]), [['/bob/*', 'owner', true, true], ['/alice/work', 'grant', true, false], ['/alice/team', 'grant', true, true], ['/carol/*', 'none', false, false]]);
  assert.equal(reachableCount([{ path: '/bob/*', level: 'own', letters: 'rwDO' }, { path: '/c/*', level: 'none', letters: '' }]), 1);
});

test('dateText formats an ISO timestamp and survives garbage', () => {
  assert.match(dateText('2026-03-04T12:00:00Z', 'en'), /2026/);
  assert.equal(dateText('', 'en'), '');
  assert.equal(dateText('nonsense', 'en'), '');
});
