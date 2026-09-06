// Wellsite Studio WS4: hydrocarbon shows (spec section 20). Every show
// characteristic is a controlled value; the quality summary is derived
// from them by a published scoring rule and is never typed. The wording
// presents indicators: it never says oil or gas was determined.

const T = (code, name, abbrev, score = 0) => Object.freeze({ code, name, abbrev, score });

export const FLUORESCENCE_COLOURS = Object.freeze([
  T('none', 'none', 'none'), T('dull_brown', 'dull brown', 'dl brn'), T('brown', 'brown', 'brn'), T('orange', 'orange', 'orng'),
  T('gold', 'gold', 'gld'), T('yellow', 'yellow', 'yel'), T('bright_yellow', 'bright yellow', 'brt yel'), T('white', 'white', 'wh'),
  T('blue_white', 'blue white', 'bl wh'), T('blue', 'blue', 'bl'), T('violet', 'violet', 'vio'),
]);
export const FLUORESCENCE_INTENSITY = Object.freeze([T('none', 'none', 'none', 0), T('dull', 'dull', 'dl', 1), T('moderate', 'moderate', 'mod', 2), T('bright', 'bright', 'brt', 3)]);
export const DISTRIBUTION_PERCENT = Object.freeze([0, 5, 10, 25, 50, 75, 100]);
export const CUT_SPEED = Object.freeze([T('none', 'none', 'none', 0), T('slow', 'slow', 'slw', 1), T('moderate', 'moderate', 'mod', 2), T('fast', 'fast', 'fst', 3), T('instant', 'instant', 'inst', 3)]);
export const CUT_TYPE = Object.freeze([T('none', 'none', 'none'), T('streaming', 'streaming', 'strm'), T('crush', 'crush', 'crsh'), T('instant', 'instant', 'inst'), T('blooming', 'blooming', 'blm')]);
export const CUT_COLOURS = Object.freeze([
  T('none', 'none', 'none'), T('milky', 'milky white', 'mky'), T('white', 'white', 'wh'), T('pale_yellow', 'pale yellow', 'pl yel'),
  T('yellow', 'yellow', 'yel'), T('straw', 'straw', 'strw'), T('amber', 'amber', 'amb'), T('brown', 'brown', 'brn'),
]);
export const STAIN = Object.freeze([T('none', 'none', 'none', 0), T('spotty', 'spotty', 'spt', 1), T('patchy', 'patchy', 'ptch', 1), T('even', 'even', 'evn', 2)]);
export const ODOUR = Object.freeze([T('none', 'none', 'none', 0), T('faint', 'faint', 'fnt', 1), T('moderate', 'moderate', 'mod', 1), T('strong', 'strong', 'strg', 1)]);
export const RESIDUE = Object.freeze([T('none', 'none', 'none'), T('light', 'light', 'lt'), T('moderate', 'moderate', 'mod'), T('heavy', 'heavy', 'hvy')]);

export const SHOW_TABLES = Object.freeze({
  fluorescenceColour: FLUORESCENCE_COLOURS, fluorescenceIntensity: FLUORESCENCE_INTENSITY, cutSpeed: CUT_SPEED, cutType: CUT_TYPE,
  cutColour: CUT_COLOURS, stain: STAIN, odour: ODOUR, residue: RESIDUE,
});

export const SHOW_QUALITIES = Object.freeze([
  { code: 'none', name: 'no show', min: 0, max: 0 },
  { code: 'poor', name: 'poor show', min: 1, max: 3 },
  { code: 'fair', name: 'fair show', min: 4, max: 6 },
  { code: 'good', name: 'good show', min: 7, max: 9 },
  { code: 'very_good', name: 'very good show', min: 10, max: 12 },
]);

const has = (table, code) => (SHOW_TABLES[table] || []).some((t) => t.code === code);
const nameOf = (table, code) => ((SHOW_TABLES[table] || []).find((t) => t.code === code) || { name: code }).name;
const scoreOf = (table, code) => ((SHOW_TABLES[table] || []).find((t) => t.code === code) || { score: 0 }).score || 0;

/** Distribution percent to its 0 to 3 score band. */
export function distributionScore(pct) {
  if (!(pct > 0)) return 0;
  if (pct <= 10) return 1;
  if (pct <= 50) return 2;
  return 3;
}

/**
 * A show record: { fluorescence:{ colour, intensity, distributionPct }, cut:{ speed, colour, type }, stain, odour, residue, comment? }
 */
export function validateShow(s) {
  const errors = [];
  if (!s || typeof s !== 'object') return ['A show record is required.'];
  const f = s.fluorescence || {};
  const c = s.cut || {};
  if (!has('fluorescenceColour', f.colour)) errors.push('Fluorescence colour must be a controlled value.');
  if (!has('fluorescenceIntensity', f.intensity)) errors.push('Fluorescence intensity must be a controlled value.');
  if (!DISTRIBUTION_PERCENT.includes(f.distributionPct)) errors.push(`Fluorescence distribution must be one of ${DISTRIBUTION_PERCENT.join(', ')} percent.`);
  if (!has('cutSpeed', c.speed)) errors.push('Cut speed must be a controlled value.');
  if (!has('cutColour', c.colour)) errors.push('Cut colour must be a controlled value.');
  if (!has('cutType', c.type)) errors.push('Cut type must be a controlled value.');
  if (!has('stain', s.stain)) errors.push('Stain must be a controlled value.');
  if (!has('odour', s.odour)) errors.push('Odour must be a controlled value.');
  if (!has('residue', s.residue)) errors.push('Residue must be a controlled value.');
  if (f.intensity === 'none' && f.colour && f.colour !== 'none') errors.push('Fluorescence colour needs an intensity above none.');
  if (c.speed === 'none' && c.type && c.type !== 'none') errors.push('A cut type needs a cut speed above none.');
  return errors;
}

export function emptyShow() {
  return { fluorescence: { colour: 'none', intensity: 'none', distributionPct: 0 }, cut: { speed: 'none', colour: 'none', type: 'none' }, stain: 'none', odour: 'none', residue: 'none', comment: '' };
}

/**
 * The derived quality: fluorescence intensity 0 to 3, distribution 0 to 3, cut speed 0 to 3,
 * stain 0 to 2, odour 0 to 1; bands 0 none, 1 to 3 poor, 4 to 6 fair, 7 to 9 good, 10 to 12 very good.
 */
export function showSummary(s) {
  const f = s.fluorescence || {};
  const c = s.cut || {};
  const parts = {
    fluorescence: scoreOf('fluorescenceIntensity', f.intensity),
    distribution: distributionScore(f.distributionPct),
    cut: scoreOf('cutSpeed', c.speed),
    stain: scoreOf('stain', s.stain),
    odour: scoreOf('odour', s.odour),
  };
  const score = parts.fluorescence + parts.distribution + parts.cut + parts.stain + parts.odour;
  const band = SHOW_QUALITIES.find((q) => score >= q.min && score <= q.max) || SHOW_QUALITIES[SHOW_QUALITIES.length - 1];
  const indicators = [];
  if (parts.fluorescence > 0) indicators.push(`${nameOf('fluorescenceIntensity', f.intensity)} ${nameOf('fluorescenceColour', f.colour)} fluorescence over ${f.distributionPct} percent of the cuttings`);
  if (parts.cut > 0) indicators.push(`${nameOf('cutSpeed', c.speed)} ${nameOf('cutType', c.type)} cut${c.colour && c.colour !== 'none' ? `, ${nameOf('cutColour', c.colour)}` : ''}`);
  if (parts.stain > 0) indicators.push(`${nameOf('stain', s.stain)} stain`);
  if (parts.odour > 0) indicators.push(`${nameOf('odour', s.odour)} odour`);
  if (s.residue && s.residue !== 'none') indicators.push(`${nameOf('residue', s.residue)} residue`);
  const text = indicators.length ? `Indicators present: ${indicators.join(', ')}. Assessed as a ${band.name}.` : 'No hydrocarbon indicators observed.';
  return { quality: band.code, qualityName: band.name, score, parts, indicators, text };
}

/** Short form for tables: "brt yel fluor 50%, fst strm cut, spt stn". */
export function showAbbrev(s) {
  const f = s.fluorescence || {};
  const c = s.cut || {};
  const ab = (table, code) => ((SHOW_TABLES[table] || []).find((t) => t.code === code) || { abbrev: code }).abbrev;
  const bits = [];
  if (f.intensity && f.intensity !== 'none') bits.push(`${ab('fluorescenceIntensity', f.intensity)} ${ab('fluorescenceColour', f.colour)} fluor ${f.distributionPct}%`);
  if (c.speed && c.speed !== 'none') bits.push(`${ab('cutSpeed', c.speed)} ${ab('cutType', c.type)} cut${c.colour && c.colour !== 'none' ? ` ${ab('cutColour', c.colour)}` : ''}`);
  if (s.stain && s.stain !== 'none') bits.push(`${ab('stain', s.stain)} stn`);
  if (s.odour && s.odour !== 'none') bits.push(`${ab('odour', s.odour)} odr`);
  if (s.residue && s.residue !== 'none') bits.push(`${ab('residue', s.residue)} res`);
  return bits.length ? bits.join(', ') : 'no show';
}
