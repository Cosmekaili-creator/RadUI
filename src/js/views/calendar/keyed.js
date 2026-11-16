// SPDX-License-Identifier: AGPL-3.0-or-later
// Keyed node reconciliation for the calendar views (SPECS 4.1 "stable toggling"). A view is built once as a
// skeleton (month cells, time columns, agenda day sections); its event nodes are keyed and are INSERTED,
// REMOVED or flagged `is-off` one by one. The skeleton, its scroller, focus and any open form are never
// re-rendered by a toggle.
//
//   const set = createNodeSet(box)                   one per container (a cell, a column, a day section)
//   set.sync(items)                                  items: [{id, sig, visible, make()}] in display order
//   set.nodes                                        Map(id -> element)
//
// A node whose `sig` is unchanged is kept as it is (same element, same focus); a changed `sig` replaces the
// element, keeping focus when it had it. Nodes are only moved when their position is wrong.

/** @returns {{nodes: Map<string, HTMLElement>, sync(items: object[]): {added: number, removed: number, replaced: number}, size: number}} */
export function createNodeSet(box) {
  const nodes = new Map();
  const sigs = new Map();
  return {
    nodes,
    get size() {
      return nodes.size;
    },
    sync(items) {
      let added = 0;
      let removed = 0;
      let replaced = 0;
      const wanted = new Set(items.map((i) => i.id));
      for (const [id, node] of [...nodes]) {
        if (wanted.has(id)) continue;
        node.remove();
        nodes.delete(id);
        sigs.delete(id);
        removed += 1;
      }
      let index = 0;
      for (const item of items) {
        let node = nodes.get(item.id);
        if (node && sigs.get(item.id) !== item.sig) {
          const fresh = item.make();
          const hadFocus = node.ownerDocument && node.ownerDocument.activeElement === node;
          box.insertBefore(fresh, node);
          node.remove();
          if (hadFocus && typeof fresh.focus === 'function') fresh.focus();
          node = fresh;
          nodes.set(item.id, node);
          sigs.set(item.id, item.sig);
          replaced += 1;
        } else if (!node) {
          node = item.make();
          nodes.set(item.id, node);
          sigs.set(item.id, item.sig);
          added += 1;
        }
        const at = box.children[index] || null;
        if (at !== node) box.insertBefore(node, at);
        node.classList.toggle('is-off', item.visible === false);
        if (item.visible === false) node.setAttribute('aria-hidden', 'true');
        else node.removeAttribute('aria-hidden');
        index += 1;
      }
      return { added, removed, replaced };
    },
    clear() {
      for (const node of nodes.values()) node.remove();
      nodes.clear();
      sigs.clear();
    },
  };
}
