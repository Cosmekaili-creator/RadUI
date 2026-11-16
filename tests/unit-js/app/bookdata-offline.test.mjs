// SPDX-License-Identifier: AGPL-3.0-or-later
// views/contacts/bookdata.js pickBook: an offline cold start is an error state, not "not found" (M4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickBook } from '../../../src/js/views/contacts/bookdata.js';

const access = (books, lastError = null) => ({ addressbooks: () => books, lastError, canCreateCollections: () => true, defaultBook: () => books[0] });
const book = { href: '/alice/book/', kind: 'addressbook' };

test('no books and a load error: the error state comes first, also when ?ab= names a book', () => {
  const err = new Error('offline');
  assert.deepEqual(pickBook(access([], err), {}), { state: 'error', books: [], error: err });
  assert.equal(pickBook(access([], err), { ab: '/alice/book/' }).state, 'error');
});

test('with books, an unknown ?ab= is still "not found" and a known one is ok', () => {
  assert.equal(pickBook(access([book], new Error('x')), { ab: '/other/' }).state, 'notfound');
  assert.equal(pickBook(access([book]), { ab: '/alice/book/' }).state, 'ok');
  assert.equal(pickBook(access([]), {}).state, 'nobook');
});
