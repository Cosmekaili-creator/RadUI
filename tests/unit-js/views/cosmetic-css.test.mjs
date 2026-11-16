// SPDX-License-Identifier: AGPL-3.0-or-later
// Run 4 cosmetic fixes: the rules exist (the rendering itself is checked by the browser scenarios).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = (n) => readFileSync(new URL(`../../../src/css/${n}.css`, import.meta.url), 'utf8');

test('recurrence "Ends": the radios share one grid column and the row wrappers are transparent to it', () => {
  const c = css('event');
  assert.match(c, /\.rec \.rec__ends \{[^}]*display: grid;[^}]*grid-template-columns: max-content/);
  assert.match(c, /\.rec \.rec__ends \.radio-row \{ display: contents; \}/);
});

test('task form: one spacing token drives every vertical gap', () => {
  const c = css('tasks');
  assert.match(c, /\.tform \{ --tform-gap: var\(--s4\); \}/);
  for (const sel of ['.tform .form, .tform .form__fields', '.tform .form__grid', '.tform__times', '.tform__when']) {
    const i = c.indexOf(`${sel} {`);
    assert.ok(i >= 0, sel);
    assert.match(c.slice(i, c.indexOf('}', i)), /var\(--tform-gap\)/, sel);
  }
});

test('users table: a login never wraps (nowrap + ellipsis above a maximum width, full text as the title)', () => {
  const c = css('users');
  const i = c.indexOf('.users .table .link-login {');
  assert.ok(i >= 0);
  const rule = c.slice(i, c.indexOf('}', i));
  assert.match(rule, /white-space: nowrap/);
  assert.match(rule, /text-overflow: ellipsis/);
  assert.match(rule, /max-width: 16rem/);
  assert.match(readFileSync(new URL('../../../src/js/views/users/accounts.js', import.meta.url), 'utf8'), /link-login[^\n]*title: a\.login/);
});
