// LAS 3.0 data blocks to interval rows (Stratigraphy Studio ST1).
//
// parseLas (3.0) hands back every non-log *_Definition / *_Data pair as a
// block: named columns plus text rows. This module turns the blocks that
// describe depth INTERVALS (a core description, a lithology or facies
// log) into geo_wells_intervals rows, and leaves point blocks (core
// plugs at one depth, tops) alone. Column roles are found by mnemonic
// and description: a top depth and a base depth are required; a
// lithology, a description, a grain size and a colour are optional.
// Depths convert to metres from the column unit (M, F, FT).

import { depthUnitToMetres } from './lasImport';
import { resolveLithology, resolveGrainSize, resolveEnvironment } from '../stratigraphy/lithology';

const ROLE_PATTERNS = {
  top: [/^(CORT|CTOP|CORETOP|TOP|TOPD|TOPDEPTH|DEPTTOP|FROM|START|STRT|LTOP|ITOP)$/i, /\b(TOP|START|FROM)\b/i],
  base: [/^(CORB|CBASE|CBOT|COREBASE|BASE|BOT|BOTTOM|TO|END|STOP|LBASE|IBASE|BASED)$/i, /\b(BASE|BOTTOM|STOP|END)\b/i],
  lithology: [/^(LITH|LITHO|LITHOLOGY|ROCK|ROCKTYPE|LTYPE|LITHCODE)$/i, /\bLITH/i, /\bROCK\b/i],
  description: [/^(DESC|DESCR|DESCRIPTION|COREDESC|REMARK|REMARKS|COMMENT|COMMENTS)$/i, /\bDESCR/i, /\bREMARK/i],
  grain: [/^(GRAIN|GSIZE|GRSZ|GRAINSIZE|GS)$/i, /\bGRAIN/i],
  colour: [/^(COLOR|COLOUR|COL)$/i, /\bCOLOU?R\b/i],
  environment: [/^(ENV|ENVIR|ENVIRONMENT|DEPENV|DEPOENV)$/i, /\bENVIRON/i],
  facies: [/^(FACIES|FAC|FACIESCODE)$/i, /\bFACIES\b/i],
};

const KIND_BY_BLOCK = [
  [/^CORE/i, 'core_description'],
  [/^LITH/i, 'lithology'],
  [/^FACIES/i, 'facies'],
  [/^ENV/i, 'environment'],
];

function findColumn(columns, role, used) {
  const [exact, loose] = ROLE_PATTERNS[role];
  const clean = (c) => String(c.mnemonic || '').replace(/\[.*$/, '');
  let idx = columns.findIndex((c, i) => !used.has(i) && exact.test(clean(c)));
  if (idx < 0 && loose) idx = columns.findIndex((c, i) => !used.has(i) && (loose.test(clean(c)) || loose.test(String(c.descr || ''))));
  if (idx >= 0) used.add(idx);
  return idx;
}

/**
 * Column roles of a block, or null when it carries no top+base pair
 * (a point block such as core plugs or tops).
 */
export function blockRoles(block) {
  const columns = block?.columns || [];
  const used = new Set();
  const top = findColumn(columns, 'top', used);
  const base = findColumn(columns, 'base', used);
  if (top < 0 || base < 0) return null;
  const roles = { top, base };
  for (const role of ['lithology', 'facies', 'description', 'grain', 'colour', 'environment']) {
    const i = findColumn(columns, role, used);
    if (i >= 0) roles[role] = i;
  }
  return roles;
}

/** The interval kind a block name implies; null for blocks that are not interval logs. */
export function blockKind(name) {
  for (const [re, kind] of KIND_BY_BLOCK) if (re.test(String(name || ''))) return kind;
  return null;
}

/**
 * @param {Record<string, {name, columns, rows}>} blocks  parseLas(...).blocks
 * @param {{ defaultKind?: string, source?: string }} [opts]
 * @returns {{ intervals: Array, skipped: Array<{block: string, reason: string}> }}
 *   intervals: {kind, top_md_m, base_md_m, code, label, properties, source}
 */
export function intervalsFromLasBlocks(blocks, { source = 'import' } = {}) {
  const intervals = [];
  const skipped = [];
  for (const block of Object.values(blocks || {})) {
    const kind = blockKind(block.name);
    if (!kind) { skipped.push({ block: block.name, reason: 'not an interval block' }); continue; }
    const roles = blockRoles(block);
    if (!roles) { skipped.push({ block: block.name, reason: 'no top and base depth columns (a point block)' }); continue; }
    const topUnit = depthUnitToMetres(block.columns[roles.top].unit || 'M');
    const baseUnit = depthUnitToMetres(block.columns[roles.base].unit || 'M');
    if (!topUnit || !baseUnit) { skipped.push({ block: block.name, reason: `depth unit "${block.columns[roles.top].unit}" is not M, F or FT` }); continue; }
    let bad = 0;
    for (const row of block.rows) {
      const top = Number(row[roles.top]);
      const base = Number(row[roles.base]);
      if (!Number.isFinite(top) || !Number.isFinite(base) || !(base > top)) { bad += 1; continue; }
      const lithText = roles.lithology != null ? row[roles.lithology] : (roles.facies != null ? row[roles.facies] : '');
      const lith = kind === 'facies' ? null : resolveLithology(lithText);
      const description = roles.description != null ? row[roles.description] : '';
      const props = {};
      if (roles.grain != null) { const g = resolveGrainSize(row[roles.grain]); if (g) props.grain_size = g.code; else if (row[roles.grain]) props.grain_size_text = row[roles.grain]; }
      if (roles.colour != null && row[roles.colour]) props.colour_text = row[roles.colour];
      if (roles.environment != null) { const e = resolveEnvironment(row[roles.environment]); if (e) props.environment = e.code; else if (row[roles.environment]) props.environment_text = row[roles.environment]; }
      if (description) props.description = description;
      if (lithText && !lith && kind !== 'facies') props.lithology_text = lithText;
      const code = kind === 'facies' ? (lithText || description || 'facies')
        : kind === 'environment' ? (props.environment || row[roles.environment] || lithText || 'unknown')
          : (lith ? lith.code : (lithText || 'unknown'));
      const label = kind === 'facies' ? code : (lith ? lith.name : (lithText || description || code));
      intervals.push({
        kind, top_md_m: top * topUnit, base_md_m: base * baseUnit, code: String(code), label: String(label),
        properties: props, source,
      });
    }
    if (bad) skipped.push({ block: block.name, reason: `${bad} row${bad === 1 ? '' : 's'} without a numeric top below base were dropped` });
  }
  return { intervals, skipped };
}
