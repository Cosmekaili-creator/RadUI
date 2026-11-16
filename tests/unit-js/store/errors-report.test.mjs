// SPDX-License-Identifier: AGPL-3.0-or-later
// store/errors.js classification and store/report.js reporting; i18n keys of the common part.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../../../src/js/api.js';
import { ConflictError, DavError } from '../../../src/js/dav/http.js';
import { FidelityError } from '../../../src/js/model/fidelity.js';
import { ReadOnlyError } from '../../../src/js/model/item.js';
import { FieldError } from '../../../src/js/model/writer.js';
import en from '../../../src/i18n/en.common.js';
import fr from '../../../src/i18n/fr.common.js';
import { davErrorKey, classify, isResultUnknown, leafOf } from '../../../src/js/store/errors.js';
import { OPS, createReporter } from '../../../src/js/store/report.js';
import { createActivityLog, createFeedback } from '../../../src/js/ui.js';

test('classify: DAV, API and model errors map to one vocabulary', () => {
  assert.equal(classify(new ConflictError({ status: 412 })).kind, 'precondition');
  for (const k of ['auth', 'forbidden', 'notfound', 'toolarge', 'network', 'server', 'conflict', 'invalid']) assert.equal(classify(new DavError(k, { status: 400 })).kind, k);
  assert.equal(classify(new ApiError('unavailable', { status: 503 })).kind, 'server');
  assert.equal(classify(new ApiError('ratelimited', { retryAfter: 9 })).retryAfter, 9);
  assert.equal(classify(new ApiError('validation', { code: 'x' })).kind, 'invalid');
  assert.equal(classify(new FidelityError([{ code: 'c', message: 'm' }])).kind, 'fidelity');
  assert.equal(classify(new ReadOnlyError('why')).kind, 'readonly');
  assert.equal(classify(new FieldError('bad')).kind, 'field');
  assert.equal(classify(new Error('x')).kind, 'unknown');
  assert.equal(classify(null).kind, 'unknown');
});

test('error keys and helpers', () => {
  assert.equal(davErrorKey('forbidden'), 'err.dav.forbidden');
  assert.equal(davErrorKey('precondition'), 'err.dav.unknown');
  for (const k of ['auth', 'forbidden', 'notfound', 'toolarge', 'network', 'server', 'unknown']) assert.ok(en[davErrorKey(k)], k);
  assert.equal(isResultUnknown('network'), true);
  assert.equal(isResultUnknown('forbidden'), false);
  assert.equal(leafOf('/alice/book/a%20b.vcf'), 'a b.vcf');
  assert.equal(leafOf(''), '');
});

test('reporter: Activity lines, status, persistent alerts, replaceable translator, safe without sinks', () => {
  const activity = createActivityLog();
  const feedback = createFeedback();
  const r = createReporter({ activity, feedback, t: (k, p) => `${k}:${JSON.stringify(p || {})}` });
  r.log('update', 'x.vcf', 'ok', 'd');
  assert.deepEqual(activity.entries()[0].op, 'update');
  assert.equal(r.status('store.status.saved'), 'store.status.saved:{}');
  r.alert('err.fidelity', undefined, { persistent: true });
  assert.equal(feedback.alert.scope, null);
  r.alert('err.dav.auth');
  assert.equal(feedback.alert.scope, feedback.screen);
  r.setTranslator(() => '');
  assert.equal(r.text('k'), 'k');
  const bare = createReporter();
  assert.equal(bare.log('update'), null);
  assert.equal(bare.status('a'), 'a');
  assert.equal(bare.alert('a'), 'a');
});

test('the common part: FR and EN keys and placeholders match; every Activity operation has a label', () => {
  assert.deepEqual(Object.keys(en), Object.keys(fr));
  const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  for (const k of Object.keys(en)) assert.equal(ph(en[k]), ph(fr[k]), k);
  for (const op of OPS) assert.ok(en[`activity.op.${op}`] && fr[`activity.op.${op}`], op);
  assert.ok(en['err.fidelity']);
  assert.ok(!('common.yes' in en) && !Object.keys(en).some((k) => k.startsWith('err.kind.')));
});
