// SPDX-License-Identifier: AGPL-3.0-or-later
// Export of one collection as a download: the store builds the file text (`exportCollection`), `downloadText`
// hands it to the browser. An address-book export leaves group cards out unless `includeGroups` is true (the
// backup offered before a delete includes them). Nothing is written to the server.

import { downloadText } from '../download.js';

/**
 * @returns {Promise<{ok: boolean, status: string, text: string, count?: number, groupsExcluded?: number, filename?: string, empty?: boolean}>}
 *   `text` is the visible outcome (status or alert text), already translated.
 */
export async function exportToFile({ store, collection, includeGroups = false, t, download = downloadText }) {
  let res;
  try {
    res = await store.exportCollection({ collection, includeGroups });
  } catch {
    return { ok: false, status: 'error', text: t('coll.export.failed') };
  }
  if (!res || !res.ok) {
    if (res && res.status === 'auth') return { ok: false, status: 'auth', text: '' };
    return { ok: false, status: (res && res.status) || 'error', text: (res && res.message) || t('coll.export.failed') };
  }
  if (res.empty) return { ok: true, status: 'empty', count: 0, groupsExcluded: res.groupsExcluded || 0, text: t('coll.export.empty') };
  const out = download({ text: res.text, mime: res.mime, filename: res.filename });
  if (!out.ok) return { ok: false, status: 'download-failed', text: t('coll.export.downloadFailed') };
  const excluded = res.groupsExcluded || 0;
  let text = t('coll.export.done', { count: res.count, file: out.filename });
  if (excluded > 0) text += ' ' + t('coll.export.groupsExcluded', { n: excluded });
  else if (includeGroups && collection.kind === 'addressbook') text += ' ' + t('coll.export.groupsIncluded');
  return { ok: true, status: 'exported', count: res.count, groupsExcluded: excluded, filename: out.filename, text };
}
