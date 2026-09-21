// Stratigraphy vocabulary (Stratigraphy Studio ST0, 2026-09-06).
//
// The stored vocabulary is Catuneanu's (Catuneanu 2006, Principles of
// Sequence Stratigraphy; Catuneanu et al. 2009, "Towards the
// standardization of sequence stratigraphy", Earth-Science Reviews 92,
// 1-33). Exxon terminology (Vail, Posamentier, Van Wagoner et al. 1988,
// 1990) is a DISPLAY OPTION ONLY: `displayLabel` maps a stored code to the
// label of the chosen scheme at render time. Nothing anywhere stores an
// Exxon code, and there is deliberately no reverse map. Where Exxon has no
// equivalent the display falls back to the Catuneanu name and says so.
//
// This file is the single source of the codes. The Suite's tops check
// constraint (migration 20260906180000) lists the same surface codes; a
// Suite-side guard test reads the migration and compares it with
// SURFACE_CODES so the two cannot drift apart.

export const SCHEMES = Object.freeze(['catuneanu', 'exxon']);
export const DEFAULT_SCHEME = 'catuneanu';
export const DEFAULT_SURFACE_TYPE = 'formation_top';

/**
 * Surface types, in the order a legend shows them. `family` groups them:
 * litho (lithostratigraphic), sequence (Catuneanu sequence-stratigraphic
 * surfaces), chrono (biostratigraphic datums, ST3). `exxon` is null where
 * the Exxon scheme has no equivalent term. `style` is the marker line
 * style every track painter uses for the type (dash pattern in px, width).
 * `order` is the position of the surface within one Catuneanu depositional
 * sequence, base to top, used by expectedTract; null for surfaces that
 * carry no sequence position.
 */
export const SURFACE_TYPES = Object.freeze([
  { code: 'formation_top', abbrev: 'Top', name: 'Formation top', family: 'litho', exxon: { label: 'Formation top', abbrev: 'Top' }, style: { dash: [5, 3], width: 1 }, order: null,
    description: 'A lithostratigraphic top, the default for every pick. Carries no sequence meaning.' },
  { code: 'SU', abbrev: 'SU', name: 'Subaerial unconformity', family: 'sequence', exxon: { label: 'Sequence boundary (SB)', abbrev: 'SB' }, style: { dash: [], width: 2.5 }, order: 0,
    description: 'Erosional or non-depositional surface formed by subaerial exposure during base-level fall. The Exxon sequence boundary.' },
  { code: 'CC', abbrev: 'CC', name: 'Correlative conformity (sensu Hunt and Tucker)', family: 'sequence', exxon: { label: 'Sequence boundary, correlative conformity', abbrev: 'SB (cc)' }, style: { dash: [12, 4], width: 2 }, order: 0,
    description: 'Marine conformity correlative to the subaerial unconformity at the END of forced regression (Hunt and Tucker 1992). Bounds the falling-stage systems tract above.' },
  { code: 'BSFR', abbrev: 'BSFR', name: 'Basal surface of forced regression (correlative conformity sensu Posamentier and Allen)', family: 'sequence', exxon: { label: 'Sequence boundary (sensu Posamentier and Allen)', abbrev: 'SB (P&A)' }, style: { dash: [12, 4, 3, 4], width: 2 }, order: 5,
    description: 'Marine surface at the ONSET of forced regression, the base of the falling-stage systems tract. Posamentier and Allen place the sequence boundary here.' },
  { code: 'RSME', abbrev: 'RSME', name: 'Regressive surface of marine erosion', family: 'sequence', exxon: null, style: { dash: [8, 3, 1, 3], width: 1.5 }, order: 6,
    description: 'Scour cut by wave action in the shoreface during forced regression. Sits within the falling-stage systems tract. No Exxon equivalent.' },
  { code: 'MRS', abbrev: 'MRS', name: 'Maximum regressive surface', family: 'sequence', exxon: { label: 'Transgressive surface (TS)', abbrev: 'TS' }, style: { dash: [2, 3], width: 1.5 }, order: 2,
    description: 'Marks the end of lowstand normal regression and the start of transgression. The Exxon transgressive surface.' },
  { code: 'TRS', abbrev: 'TRS', name: 'Transgressive ravinement surface', family: 'sequence', exxon: { label: 'Transgressive surface (ravinement)', abbrev: 'TS (rav)' }, style: { dash: [2, 3, 6, 3], width: 1.5 }, order: 2,
    description: 'Erosional surface cut by wave or tidal scour during transgression; may replace the maximum regressive surface where it cuts down through it.' },
  { code: 'MFS', abbrev: 'MFS', name: 'Maximum flooding surface', family: 'sequence', exxon: { label: 'Maximum flooding surface (MFS)', abbrev: 'MFS' }, style: { dash: [8, 3, 2, 3], width: 2 }, order: 4,
    description: 'Marks the end of transgression and the start of highstand normal regression. Also the Exxon downlap surface.' },
  { code: 'unconformity', abbrev: 'Unc', name: 'Unconformity, unclassified', family: 'sequence', exxon: { label: 'Unconformity, unclassified', abbrev: 'Unc' }, style: { dash: [10, 3, 2, 3], width: 2 }, order: null,
    description: 'An unconformity not yet classified within a sequence model.' },
  { code: 'biozone', abbrev: 'Bio', name: 'Biostratigraphic datum', family: 'chrono', exxon: { label: 'Biostratigraphic datum', abbrev: 'Bio' }, style: { dash: [1, 3], width: 1 }, order: null,
    description: 'A biozone top or base, or a dated event, carrying an age (ST3).' },
]);

export const SURFACE_CODES = Object.freeze(SURFACE_TYPES.map((s) => s.code));

/**
 * Systems tracts (Catuneanu). `order` is the position within one
 * depositional sequence, base to top. FSST and RST have no Exxon
 * equivalent: Exxon folds the falling-stage deposits into the lowstand
 * (Posamentier) or the late highstand (Van Wagoner), and the regressive
 * systems tract belongs to the transgressive-regressive sequence model.
 */
export const SYSTEMS_TRACTS = Object.freeze([
  { code: 'LST', name: 'Lowstand systems tract', exxon: { label: 'Lowstand systems tract', abbrev: 'LST' }, order: 1, colour: '#f59e0b',
    description: 'Lowstand normal regression, from the sequence boundary (subaerial unconformity or correlative conformity) to the maximum regressive surface.' },
  { code: 'TST', name: 'Transgressive systems tract', exxon: { label: 'Transgressive systems tract', abbrev: 'TST' }, order: 2, colour: '#0ea5e9',
    description: 'Retrogradation from the maximum regressive surface to the maximum flooding surface.' },
  { code: 'HST', name: 'Highstand systems tract', exxon: { label: 'Highstand systems tract', abbrev: 'HST' }, order: 3, colour: '#10b981',
    description: 'Highstand normal regression from the maximum flooding surface to the basal surface of forced regression.' },
  { code: 'FSST', name: 'Falling-stage systems tract', exxon: null, order: 4, colour: '#ef4444',
    description: 'Forced regression from the basal surface of forced regression to the correlative conformity. Exxon has no separate tract for it.' },
  { code: 'RST', name: 'Regressive systems tract', exxon: null, order: null, colour: '#a855f7',
    description: 'Transgressive-regressive sequences: all regressive deposits from a maximum flooding surface to the next maximum regressive surface. No Exxon equivalent.' },
]);

export const TRACT_CODES = Object.freeze(SYSTEMS_TRACTS.map((t) => t.code));

/** Gamma-ray log motifs (Rider). Identical in both schemes. */
export const MOTIFS = Object.freeze([
  { code: 'blocky', name: 'Blocky (cylindrical)', description: 'Sharp base and top, uniform response: aggradational channel, eolian or reef.' },
  { code: 'bell', name: 'Bell (fining upward)', description: 'Sharp base, gradational top: fluvial or tidal channel fill, transgressive shoreface.' },
  { code: 'funnel', name: 'Funnel (coarsening upward)', description: 'Gradational base, sharp top: prograding delta front, shoreface, crevasse splay.' },
  { code: 'bow', name: 'Bow (symmetric)', description: 'Coarsening then fining: prograding then retreating bar or lobe.' },
  { code: 'serrated', name: 'Serrated (irregular)', description: 'Thin interbeds with no trend: floodplain, distal turbidites, storm deposits.' },
]);

export const MOTIF_CODES = Object.freeze(MOTIFS.map((m) => m.code));

/** Parasequence stacking patterns, a property of a systems tract. */
export const STACKING_PATTERNS = Object.freeze([
  { code: 'progradational', name: 'Progradational', description: 'Each parasequence steps basinward: sediment supply exceeds accommodation.' },
  { code: 'retrogradational', name: 'Retrogradational', description: 'Each parasequence steps landward: accommodation exceeds supply.' },
  { code: 'aggradational', name: 'Aggradational', description: 'Parasequences stack vertically: supply keeps pace with accommodation.' },
]);

export const STACKING_CODES = Object.freeze(STACKING_PATTERNS.map((s) => s.code));

const bySurface = new Map(SURFACE_TYPES.map((s) => [s.code, s]));
const byTract = new Map(SYSTEMS_TRACTS.map((t) => [t.code, t]));
const byMotif = new Map(MOTIFS.map((m) => [m.code, m]));

export const surfaceType = (code) => bySurface.get(code) || null;
export const systemsTract = (code) => byTract.get(code) || null;
export const motif = (code) => byMotif.get(code) || null;
export const isSurfaceCode = (code) => bySurface.has(code);
export const isTractCode = (code) => byTract.has(code);
export const isMotifCode = (code) => byMotif.has(code);

/** A null or unknown stored value reads as the default lithostratigraphic top. */
export const normalizeSurfaceType = (code) => (code && bySurface.has(code) ? code : DEFAULT_SURFACE_TYPE);

/** @param {string} scheme */
export function assertScheme(scheme) {
  if (!SCHEMES.includes(scheme)) throw new RangeError(`Unknown terminology scheme "${scheme}", expected one of ${SCHEMES.join(', ')}.`);
  return scheme;
}

/**
 * The label of a stored code in the chosen scheme.
 * @param {string} code a surface, tract or motif code
 * @param {'catuneanu'|'exxon'} [scheme]
 * @param {{ kind?: 'surface'|'tract'|'motif', short?: boolean }} [opts]
 *   kind defaults to whichever table holds the code (surfaces first);
 *   short returns the abbreviation instead of the full name.
 * @returns {{ label: string, scheme: 'catuneanu'|'exxon', fallback: boolean, code: string }}
 *   `fallback` is true when the requested scheme has no term for the code
 *   and the Catuneanu label was returned instead (the UI shows a badge).
 */
export function displayLabel(code, scheme = DEFAULT_SCHEME, { kind, short = false } = {}) {
  assertScheme(scheme);
  let entry = null;
  if (kind === 'surface' || (!kind && bySurface.has(code))) entry = bySurface.get(code) || null;
  else if (kind === 'tract' || (!kind && byTract.has(code))) entry = byTract.get(code) || null;
  else if (kind === 'motif' || (!kind && byMotif.has(code))) entry = byMotif.get(code) || null;
  if (!entry) throw new RangeError(`Unknown stratigraphy code "${code}".`);
  const own = short ? (entry.abbrev || entry.code) : entry.name;
  if (scheme === 'catuneanu' || !('exxon' in entry)) return { label: own, scheme: 'catuneanu', fallback: false, code };
  if (!entry.exxon) return { label: own, scheme: 'catuneanu', fallback: true, code };
  return { label: short ? entry.exxon.abbrev : entry.exxon.label, scheme: 'exxon', fallback: false, code };
}

/** Marker line style of a surface type: {dash, width}. Unknown codes draw as formation tops. */
export function surfaceLineStyle(code) {
  const s = bySurface.get(normalizeSurfaceType(code));
  return { dash: [...s.style.dash], width: s.style.width };
}

/**
 * The systems tract expected between two Catuneanu surfaces on one well,
 * lower (older, deeper) and upper (younger, shallower), in the
 * depositional-sequence model with the correlative conformity sensu Hunt
 * and Tucker, plus the transgressive-regressive model for MFS to MRS.
 * Returns null when the pair bounds no single tract (a formation top, an
 * unclassified unconformity, two surfaces in the wrong order, or a pair
 * that spans more than one tract). `certain` is false when the pair
 * legitimately spans two tracts whose internal boundary was not picked
 * (MFS up to SU or CC without a BSFR: highstand plus falling stage).
 * @returns {{ code: string, certain: boolean } | null}
 */
export function expectedTract(lowerCode, upperCode) {
  const lo = bySurface.get(lowerCode);
  const up = bySurface.get(upperCode);
  if (!lo || !up || lo.order == null || up.order == null) return null;
  const key = `${lowerCode}>${upperCode}`;
  const exact = {
    'SU>MRS': 'LST', 'CC>MRS': 'LST', 'SU>TRS': 'LST', 'CC>TRS': 'LST',
    'MRS>MFS': 'TST', 'TRS>MFS': 'TST',
    'MFS>BSFR': 'HST',
    'BSFR>CC': 'FSST', 'BSFR>SU': 'FSST', 'RSME>CC': 'FSST', 'RSME>SU': 'FSST', 'BSFR>RSME': 'FSST',
    'MFS>MRS': 'RST', 'MFS>TRS': 'RST',
  };
  if (exact[key]) return { code: exact[key], certain: true };
  if ((lowerCode === 'MFS') && (upperCode === 'SU' || upperCode === 'CC')) return { code: 'HST', certain: false };
  return null;
}

/**
 * Sort key for surfaces of one sequence, base to top. Surfaces without a
 * sequence position sort after those with one, alphabetically.
 */
export function surfaceOrder(code) {
  const s = bySurface.get(code);
  return s && s.order != null ? s.order : Number.POSITIVE_INFINITY;
}

/**
 * Legend rows for a scheme: every surface and tract with its label in the
 * scheme and whether that label is a fallback. The Stratigraphy Studio
 * glossary and the correlation legend both render from this.
 */
export function legend(scheme = DEFAULT_SCHEME) {
  assertScheme(scheme);
  return {
    surfaces: SURFACE_TYPES.map((s) => ({ code: s.code, family: s.family, style: surfaceLineStyle(s.code), catuneanu: s.name, ...displayLabel(s.code, scheme, { kind: 'surface' }), abbrev: displayLabel(s.code, scheme, { kind: 'surface', short: true }).label, description: s.description })),
    tracts: SYSTEMS_TRACTS.map((t) => ({ code: t.code, colour: t.colour, catuneanu: t.name, ...displayLabel(t.code, scheme, { kind: 'tract' }), abbrev: displayLabel(t.code, scheme, { kind: 'tract', short: true }).label, description: t.description })),
    motifs: MOTIFS.map((m) => ({ code: m.code, label: m.name, description: m.description })),
  };
}
