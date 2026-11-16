// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { foldText, foldTokens, matchesTokens } from '../../../src/js/widgets/fold.js';

test('foldText: accents, case, ligatures and apostrophes', () => {
  assert.equal(foldText('Zoë'), 'zoe');
  assert.equal(foldText('ÉLÉONORE'), 'eleonore');
  assert.equal(foldText('Œuvre'), 'oeuvre');
  assert.equal(foldText('cœur'), 'coeur');
  assert.equal(foldText('Æsop'), 'aesop');
  assert.equal(foldText('Straße'), 'strasse');
  assert.equal(foldText('STRAẞE'), 'strasse');
  assert.equal(foldText('D’Arc'), "d'arc");
  assert.equal(foldText('DʼArc'), "d'arc");
  assert.equal(foldText("d'arc"), foldText('D’ARC'));
});

test('foldText: composed and decomposed forms fold to the same text', () => {
  assert.equal(foldText('é'), foldText('é'));
  assert.equal(foldText('Niño'), 'nino');
});

test('foldText: non-strings and empty input give an empty string; other scripts are kept', () => {
  assert.equal(foldText(null), '');
  assert.equal(foldText(undefined), '');
  assert.equal(foldText(42), '');
  assert.equal(foldText(''), '');
  assert.equal(foldText('山田 太郎'), '山田 太郎');
});

test('foldTokens and matchesTokens: every word must match somewhere', () => {
  assert.deepEqual(foldTokens('  Éric   D’Arc '), ['eric', "d'arc"]);
  assert.deepEqual(foldTokens(''), []);
  const hay = foldText('Jane Doe, Œuvres Ltd');
  assert.equal(matchesTokens(hay, foldTokens('jane oeuvres')), true);
  assert.equal(matchesTokens(hay, foldTokens('jane smith')), false);
  assert.equal(matchesTokens(hay, []), true);
});
