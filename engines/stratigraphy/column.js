// Stratigraphic column arithmetic (Stratigraphy Studio ST0, 2026-09-06).
//
// A column is a set of lithostratigraphic units (group > formation >
// member > bed) with an optional parent, an order among siblings and
// optional ages. This module turns the flat rows the registry stores
// (geo_strat_units) into an ordered tree, walks it top-down, and checks
// the things a column editor must refuse: cycles, a child outside its
// parent's rank order, and a child's age range outside its parent's.
// Closed-form list arithmetic; analytic tests only.

export const RANKS = Object.freeze(['group', 'formation', 'member', 'bed']);

const rankIndex = (rank) => RANKS.indexOf(rank);

export const isRank = (rank) => RANKS.includes(rank);

/**
 * @typedef {Object} StratUnit
 * @property {string} id
 * @property {string} name
 * @property {'group'|'formation'|'member'|'bed'} rank
 * @property {?string} parent_id
 * @property {?number} order_index   position among siblings, top (youngest) first
 * @property {?number} age_top_ma
 * @property {?number} age_base_ma
 * @property {?string} colour
 * @property {?string} lithology
 */

/** Siblings sort by order_index (nulls last), then by top age, then by name. */
export function compareSiblings(a, b) {
  const ai = a.order_index ?? Number.POSITIVE_INFINITY;
  const bi = b.order_index ?? Number.POSITIVE_INFINITY;
  if (ai !== bi) return ai - bi;
  const at = a.age_top_ma ?? Number.POSITIVE_INFINITY;
  const bt = b.age_top_ma ?? Number.POSITIVE_INFINITY;
  if (at !== bt) return at - bt;
  return String(a.name).localeCompare(String(b.name));
}

/**
 * Build the tree. Rows whose parent is missing from the set become roots
 * (and are reported in `orphans`); a row whose parent chain loops is cut
 * at the loop and reported in `cycles`.
 * @param {StratUnit[]} units
 * @returns {{ roots: Array<StratUnit & {children: any[], depth: number}>, byId: Map, orphans: string[], cycles: string[] }}
 */
export function buildColumnTree(units) {
  const byId = new Map(units.map((u) => [u.id, { ...u, children: [], depth: 0 }]));
  const roots = [];
  const orphans = [];
  const cycles = [];
  for (const node of byId.values()) {
    if (node.parent_id == null) { roots.push(node); continue; }
    const parent = byId.get(node.parent_id);
    if (!parent) { orphans.push(node.id); roots.push(node); continue; }
    // walk up to detect a loop before attaching
    let p = parent; let looped = false; const seen = new Set([node.id]);
    while (p) {
      if (seen.has(p.id)) { looped = true; break; }
      seen.add(p.id);
      p = p.parent_id == null ? null : byId.get(p.parent_id) || null;
    }
    if (looped) { cycles.push(node.id); roots.push(node); continue; }
    parent.children.push(node);
  }
  const sortRec = (list, depth) => {
    list.sort(compareSiblings);
    for (const n of list) { n.depth = depth; sortRec(n.children, depth + 1); }
  };
  sortRec(roots, 0);
  return { roots, byId, orphans, cycles };
}

/** Depth-first, top-down flattening of the tree: the order a column is drawn. */
export function orderedUnits(units) {
  const { roots } = buildColumnTree(units);
  const out = [];
  const walk = (n) => { out.push(n); n.children.forEach(walk); };
  roots.forEach(walk);
  return out;
}

/** Parent chain of a unit, outermost first (group, formation, ...). */
export function lineageOf(units, id) {
  const byId = new Map(units.map((u) => [u.id, u]));
  const chain = [];
  const seen = new Set();
  let u = byId.get(id) || null;
  while (u && !seen.has(u.id)) {
    seen.add(u.id);
    chain.unshift(u);
    u = u.parent_id == null ? null : byId.get(u.parent_id) || null;
  }
  return chain;
}

/**
 * Problems a column editor refuses to save. Each problem names the unit
 * and says what is wrong, in plain words the UI can show as-is.
 * @param {StratUnit[]} units
 * @returns {Array<{ id: string, code: string, message: string }>}
 */
export function validateColumn(units) {
  const problems = [];
  const byId = new Map(units.map((u) => [u.id, u]));
  const { orphans, cycles } = buildColumnTree(units);
  for (const id of orphans) problems.push({ id, code: 'orphan', message: `${byId.get(id).name}: its parent is not in this column.` });
  for (const id of cycles) problems.push({ id, code: 'cycle', message: `${byId.get(id).name}: its parent chain loops back on itself.` });
  for (const u of units) {
    if (!String(u.name || '').trim()) problems.push({ id: u.id, code: 'name', message: 'A unit has no name.' });
    if (!isRank(u.rank)) problems.push({ id: u.id, code: 'rank', message: `${u.name}: rank "${u.rank}" is not one of ${RANKS.join(', ')}.` });
    const hasTop = u.age_top_ma != null; const hasBase = u.age_base_ma != null;
    if (hasTop && !Number.isFinite(u.age_top_ma)) problems.push({ id: u.id, code: 'age', message: `${u.name}: the top age is not a number.` });
    if (hasBase && !Number.isFinite(u.age_base_ma)) problems.push({ id: u.id, code: 'age', message: `${u.name}: the base age is not a number.` });
    if (hasTop && hasBase && Number.isFinite(u.age_top_ma) && Number.isFinite(u.age_base_ma) && u.age_base_ma < u.age_top_ma) {
      problems.push({ id: u.id, code: 'age-order', message: `${u.name}: the base age (${u.age_base_ma} Ma) is younger than the top age (${u.age_top_ma} Ma).` });
    }
    const parent = u.parent_id == null ? null : byId.get(u.parent_id);
    if (parent && isRank(u.rank) && isRank(parent.rank) && rankIndex(u.rank) <= rankIndex(parent.rank)) {
      problems.push({ id: u.id, code: 'rank-order', message: `${u.name} (${u.rank}) cannot sit inside ${parent.name} (${parent.rank}).` });
    }
    if (parent) {
      if (hasTop && parent.age_top_ma != null && u.age_top_ma < parent.age_top_ma) problems.push({ id: u.id, code: 'age-outside', message: `${u.name}: its top (${u.age_top_ma} Ma) is younger than the top of ${parent.name} (${parent.age_top_ma} Ma).` });
      if (hasBase && parent.age_base_ma != null && u.age_base_ma > parent.age_base_ma) problems.push({ id: u.id, code: 'age-outside', message: `${u.name}: its base (${u.age_base_ma} Ma) is older than the base of ${parent.name} (${parent.age_base_ma} Ma).` });
    }
  }
  return problems;
}

/**
 * Age of a unit for a top that names it but carries no age of its own:
 * the unit's top age, else the nearest ancestor's top age, else null.
 */
export function inheritedTopAge(units, id) {
  const chain = lineageOf(units, id);
  for (let i = chain.length - 1; i >= 0; i--) if (chain[i].age_top_ma != null) return chain[i].age_top_ma;
  return null;
}
