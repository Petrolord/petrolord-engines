// Wellsite Studio WS1: abbreviation profiles (spec section 18). The
// stored description uses canonical codes; a profile is a display rule
// set over those codes (the displayLabel pattern of the stratigraphy
// vocabulary): an operator house style overrides any term, and a term it
// does not define falls back to the Petrolord default with fallback:true
// so the screen can say so. abbreviate() renders the operator-standard
// string, narrative() the full sentence form; both are representations,
// the structured record is authoritative.

import { ATTRIBUTES, TABLES, resolveLithology } from './descriptionVocabulary.js';
import { LITHOLOGIES, GRAIN_SIZES } from '../stratigraphy/lithology.js';

const LITH_ABBREV = Object.freeze({
  sandstone: 'SST', siltstone: 'SLTST', shale: 'SH', marl: 'MRL', conglomerate: 'CGL', limestone: 'LST', chalk: 'CHK',
  dolomite: 'DOL', anhydrite: 'ANHY', gypsum: 'GYP', halite: 'SALT', coal: 'COAL', chert: 'CHT', volcanic: 'VOLC',
  basement: 'BSMT', unknown: 'UNK',
});
const GRAIN_ABBREV = Object.freeze({
  clay: 'cly', silt: 'slt', vf_sand: 'vf', f_sand: 'f', m_sand: 'm', c_sand: 'c', vc_sand: 'vc',
  granule: 'gran', pebble: 'pbl', cobble: 'cbl', boulder: 'bldr',
});
const GRAIN_NARRATIVE = Object.freeze({
  clay: 'clay', silt: 'silt', vf_sand: 'very fine', f_sand: 'fine', m_sand: 'medium', c_sand: 'coarse', vc_sand: 'very coarse',
  granule: 'granule', pebble: 'pebble', cobble: 'cobble', boulder: 'boulder',
});

function tableTerms(table) {
  const out = {};
  for (const t of TABLES[table] || []) out[t.code] = t.abbrev || t.code;
  return out;
}

export const PETROLORD_PROFILE = Object.freeze({
  id: 'petrolord',
  name: 'Petrolord default',
  version: 1,
  order: ['lithology', 'percent', 'colour', 'hardness', 'grainSize', 'sorting', 'rounding', 'texture', 'cement', 'accessories', 'fossils', 'porosity', 'porosityTypes'],
  terms: Object.freeze({
    lithology: LITH_ABBREV,
    grainSize: GRAIN_ABBREV,
    colourHue: tableTerms('colourHue'),
    colourModifier: tableTerms('colourModifier'),
    hardness: tableTerms('hardness'),
    texture: tableTerms('texture'),
    sorting: tableTerms('sorting'),
    rounding: tableTerms('rounding'),
    cement: tableTerms('cement'),
    accessories: tableTerms('accessories'),
    fossils: tableTerms('fossils'),
    porosity: tableTerms('porosity'),
    porosityTypes: tableTerms('porosityTypes'),
    amount: tableTerms('amount'),
  }),
  format: Object.freeze({
    percentStyle: 'prefix',        // "60% SST" (prefix) or "SST (60%)" (suffix)
    componentSeparator: '; ',
    attributeSeparator: ', ',
    lithologySeparator: ': ',
    rangeJoiner: '-',
    grainSuffix: ' gr',
    cementSuffix: ' cmt',
    lithologyCase: 'upper',
  }),
});

export const PROFILE_TABLES = Object.freeze(Object.keys(PETROLORD_PROFILE.terms));
const ORDER_KEYS = new Set(ATTRIBUTES.map((a) => a.key));

/** Refuse a profile that names unknown tables, unknown codes, or dashes as terms. */
export function validateProfile(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return ['A profile must be an object.'];
  if (!p.id || typeof p.id !== 'string') errors.push('A profile needs an id.');
  if (p.order) {
    if (!Array.isArray(p.order)) errors.push('Profile order must be a list of attribute keys.');
    else for (const k of p.order) if (!ORDER_KEYS.has(k)) errors.push(`Profile order names an unknown attribute ${k}.`);
  }
  for (const [table, terms] of Object.entries(p.terms || {})) {
    if (!PROFILE_TABLES.includes(table)) { errors.push(`Profile names an unknown table ${table}.`); continue; }
    const known = new Set(Object.keys(PETROLORD_PROFILE.terms[table]));
    for (const [code, text] of Object.entries(terms || {})) {
      if (!known.has(code)) errors.push(`Profile table ${table} names an unknown code ${code}.`);
      if (typeof text !== 'string' || !text.trim()) errors.push(`Profile term ${table}.${code} must be a non-empty string.`);
      else if (/[–—]/.test(text)) errors.push(`Profile term ${table}.${code} uses a dash character that the copy rule forbids.`);
    }
  }
  if (p.format) for (const k of Object.keys(p.format)) if (!(k in PETROLORD_PROFILE.format)) errors.push(`Profile format names an unknown option ${k}.`);
  return errors;
}

/** The effective profile: operator terms over the Petrolord default. */
export function mergeProfile(operator) {
  if (!operator) return PETROLORD_PROFILE;
  const terms = {};
  for (const table of PROFILE_TABLES) terms[table] = { ...PETROLORD_PROFILE.terms[table], ...((operator.terms || {})[table] || {}) };
  return {
    id: operator.id || 'operator', name: operator.name || operator.id || 'Operator', version: operator.version || 1,
    order: operator.order && operator.order.length ? operator.order : PETROLORD_PROFILE.order,
    terms, format: { ...PETROLORD_PROFILE.format, ...(operator.format || {}) },
    base: PETROLORD_PROFILE.id, overrides: operator.terms || {},
  };
}

/** One term under a profile: {label, fallback, code}. */
export function term(profile, table, code, { short = true } = {}) {
  const p = profile || PETROLORD_PROFILE;
  if (!short) return { label: longName(table, code), fallback: false, code };
  if (code == null || code === '') return { label: '', fallback: false, code: null };
  const own = p.overrides && p.overrides[table] && p.overrides[table][code];
  const label = (p.terms && p.terms[table] && p.terms[table][code]) || longName(table, code) || code;
  return { label, fallback: !!(p.overrides && !own && p.id !== PETROLORD_PROFILE.id), code };
}

function longName(table, code) {
  if (table === 'lithology') return (LITHOLOGIES.find((l) => l.code === code) || {}).name || code;
  if (table === 'grainSize') return GRAIN_NARRATIVE[code] || (GRAIN_SIZES.find((g) => g.code === code) || {}).name || code;
  const t = (TABLES[table] || []).find((x) => x.code === code);
  return t ? t.name : code;
}

const cased = (s, mode) => (mode === 'upper' ? s.toUpperCase() : mode === 'lower' ? s.toLowerCase() : s);
const listOf = (v) => (Array.isArray(v) ? v : []);
const codeOf = (v) => (typeof v === 'string' ? v : v && v.code);
const amountOf = (v) => (v && typeof v === 'object' ? v.amount || null : null);

function partsShort(c, p, fallbacks) {
  const t = (table, code) => { const r = term(p, table, code); if (r.fallback) fallbacks.push({ table, code }); return r.label; };
  const f = p.format;
  const parts = [];
  for (const key of p.order) {
    if (key === 'lithology' || key === 'percent') continue;
    if (key === 'colour' && c.colour && c.colour.hue) parts.push([c.colour.modifier ? t('colourModifier', c.colour.modifier) : null, t('colourHue', c.colour.hue)].filter(Boolean).join(' '));
    else if (key === 'hardness' && c.hardness) parts.push(t('hardness', c.hardness));
    else if (key === 'grainSize' && c.grainSize && c.grainSize.from) parts.push(`${t('grainSize', c.grainSize.from)}${c.grainSize.to ? f.rangeJoiner + t('grainSize', c.grainSize.to) : ''}${f.grainSuffix}`);
    else if (key === 'sorting' && c.sorting) parts.push(t('sorting', c.sorting));
    else if (key === 'rounding' && c.rounding) parts.push(c.rounding.from ? `${t('rounding', c.rounding.from)}${f.rangeJoiner}${t('rounding', c.rounding.to)}` : t('rounding', c.rounding));
    else if (key === 'texture') for (const v of listOf(c.texture)) parts.push(t('texture', codeOf(v)));
    else if (key === 'cement') for (const v of listOf(c.cement)) parts.push(codeOf(v) === 'none' ? t('cement', 'none') : `${t('cement', codeOf(v))}${f.cementSuffix}`);
    else if (key === 'accessories' || key === 'fossils') for (const v of listOf(c[key])) parts.push([amountOf(v) ? t('amount', amountOf(v)) : null, t(key, codeOf(v))].filter(Boolean).join(' '));
    else if (key === 'porosity' && c.porosity) parts.push(t('porosity', c.porosity));
    else if (key === 'porosityTypes') for (const v of listOf(c.porosityTypes)) parts.push(t('porosityTypes', codeOf(v)));
  }
  return parts;
}

/** The operator-standard abbreviation string of a description. */
export function abbreviate(description, profileIn = PETROLORD_PROFILE) {
  const p = profileIn === PETROLORD_PROFILE || profileIn.base ? profileIn : mergeProfile(profileIn);
  const f = p.format;
  const fallbacks = [];
  // a component without a lithology is a draft row: it renders nothing until it has one
  const comps = (description.components || []).filter((c) => c && c.lithology).map((c) => {
    const lithTerm = term(p, 'lithology', c.lithology);
    if (lithTerm.fallback) fallbacks.push({ table: 'lithology', code: c.lithology });
    const lith = cased(lithTerm.label, f.lithologyCase);
    const pct = Number.isFinite(c.percent) ? `${c.percent}%` : null;
    const head = pct ? (f.percentStyle === 'suffix' ? `${lith} (${pct})` : `${pct} ${lith}`) : lith;
    const rest = partsShort(c, p, fallbacks);
    return rest.length ? `${head}${f.lithologySeparator}${rest.join(f.attributeSeparator)}` : head;
  });
  let text = comps.join(f.componentSeparator);
  if (description.comment) text += `${f.componentSeparator}${description.comment}`;
  return { text, fallbacks };
}

const ROUND_NARR = { angular: 'angular', subangular: 'subangular', subrounded: 'subrounded', rounded: 'rounded', well_rounded: 'well rounded' };

/** The full sentence form of a description. */
export function narrative(description) {
  const sentences = (description.components || []).filter((c) => c && c.lithology).map((c) => {
    const lith = resolveLithology(c.lithology);
    const bits = [];
    if (c.colour && c.colour.hue) bits.push([c.colour.modifier ? longName('colourModifier', c.colour.modifier) : null, longName('colourHue', c.colour.hue)].filter(Boolean).join(' '));
    if (c.hardness) bits.push(longName('hardness', c.hardness));
    if (c.grainSize && c.grainSize.from) {
      const g = GRAIN_NARRATIVE[c.grainSize.from] || c.grainSize.from;
      const g2 = c.grainSize.to ? GRAIN_NARRATIVE[c.grainSize.to] || c.grainSize.to : null;
      bits.push(`${g}${g2 ? ` to ${g2}` : ''} grained`);
    }
    if (c.rounding) bits.push(c.rounding.from ? `${ROUND_NARR[c.rounding.from]} to ${ROUND_NARR[c.rounding.to]}` : ROUND_NARR[c.rounding] || c.rounding);
    if (c.sorting) bits.push(longName('sorting', c.sorting));
    for (const v of listOf(c.texture)) bits.push(longName('texture', codeOf(v)));
    for (const v of listOf(c.cement)) bits.push(codeOf(v) === 'none' ? 'no visible cement' : `${longName('cement', codeOf(v))} cement`);
    for (const key of ['accessories', 'fossils']) for (const v of listOf(c[key])) bits.push([amountOf(v) ? longName('amount', amountOf(v)) : null, longName(key, codeOf(v))].filter(Boolean).join(' '));
    if (c.porosity) bits.push(longName('porosity', c.porosity));
    for (const v of listOf(c.porosityTypes)) bits.push(`${longName('porosityTypes', codeOf(v))} porosity`);
    const head = `${lith ? lith.name : c.lithology}${Number.isFinite(c.percent) ? ` (${c.percent} percent)` : ''}`;
    const s = bits.length ? `${head}, ${bits.join(', ')}.` : `${head}.`;
    return s.charAt(0).toUpperCase() + s.slice(1);
  });
  if (description.comment) sentences.push(description.comment.replace(/\.?$/, '.'));
  return { text: sentences.join(' ') };
}
