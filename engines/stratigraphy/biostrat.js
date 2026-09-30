// Biostratigraphic events and the event-based age model (Stratigraphy
// Studio AppUpgrade STRAT-U2-009 and U2-010, 2026-09-30).
//
// Events. A well is drilled from the top, so what a biostratigrapher reads
// off cuttings is the highest and lowest sample holding a taxon: the first
// downhole occurrence (FDO, the top occurrence) and the last downhole
// occurrence (LDO, the base occurrence). Their chronostratigraphic meaning
// is the taxon's last appearance datum (LAD, extinction) and first
// appearance datum (FAD, first evolutionary appearance) when the record is
// complete; caving can move an LDO down and reworking an FDO up. Acme and
// common-occurrence events mark a change in abundance. The event is stored
// as a typed top (surface type `biozone`) named "<EVENT> <taxon>" (for
// example "LAD Discoaster quinqueramus"), so no schema is needed.
//
// Age model. Dated events (depth, age) are fitted by ordinary least
// squares, age = a + b * depth, per segment between unconformities (a
// hiatus breaks the line). The rate is 1/b. The fit reports each event's
// residual and flags the ones more than twice the residual standard
// deviation off the line (candidates for caving or reworking); nothing is
// dropped. Gate: the least-squares core reproduces the NIST StRD certified
// values of the Norris data set (test-data/stratigraphy/nist-strd-norris.dat).
// Pure.

export const BIO_EVENTS = Object.freeze([
  { code: 'FDO', name: 'First downhole occurrence', top: true, chron: 'LAD', description: 'Highest sample holding the taxon (its top occurrence in the well); the well-site reading of the last appearance datum, moved up by reworking.' },
  { code: 'LDO', name: 'Last downhole occurrence', top: false, chron: 'FAD', description: 'Lowest sample holding the taxon (its base occurrence in the well); the well-site reading of the first appearance datum, moved down by caving.' },
  { code: 'LAD', name: 'Last appearance datum', top: true, chron: 'LAD', description: 'Extinction of the taxon: the youngest level it occurs at, a calibrated datum.' },
  { code: 'FAD', name: 'First appearance datum', top: false, chron: 'FAD', description: 'First evolutionary appearance of the taxon: the oldest level it occurs at, a calibrated datum.' },
  { code: 'ACME_TOP', name: 'Top of acme', top: true, chron: null, description: 'Top of an interval where the taxon is abundant.' },
  { code: 'ACME_BASE', name: 'Base of acme', top: false, chron: null, description: 'Base of an interval where the taxon is abundant.' },
  { code: 'LCO', name: 'Last common occurrence', top: true, chron: null, description: 'Highest level where the taxon is common (top of its common range).' },
  { code: 'FCO', name: 'First common occurrence', top: false, chron: null, description: 'Lowest level where the taxon is common (base of its common range).' },
]);
export const BIO_EVENT_CODES = Object.freeze(BIO_EVENTS.map((e) => e.code));
const ALIASES = { T: 'FDO', TOP: 'FDO', HO: 'FDO', B: 'LDO', BASE: 'LDO', LO: 'LDO', 'ACME TOP': 'ACME_TOP', 'TOP ACME': 'ACME_TOP', TA: 'ACME_TOP', 'ACME BASE': 'ACME_BASE', 'BASE ACME': 'ACME_BASE', BA: 'ACME_BASE', LCO: 'LCO', FCO: 'FCO', TC: 'LCO', BC: 'FCO' };

/** The event of a code or alias ("T", "HO", "top acme" ...), or null. */
export function bioEvent(code) {
  const k = String(code ?? '').trim().toUpperCase().replace(/[_-]+/g, ' ');
  const c = BIO_EVENT_CODES.includes(k.replace(/ /g, '_')) ? k.replace(/ /g, '_') : ALIASES[k] || null;
  return BIO_EVENTS.find((e) => e.code === c) || null;
}

/** The stored top name of an event: "LAD Discoaster quinqueramus". */
export function eventTopName(code, taxon) {
  const e = bioEvent(code);
  const t = String(taxon ?? '').trim().replace(/\s+/g, ' ');
  if (!e) throw new Error(`"${code}" is not a biostratigraphic event (${BIO_EVENT_CODES.join(', ')}).`);
  if (!t) throw new Error('The event needs a taxon.');
  return `${e.code} ${t}`;
}

/**
 * {event, taxon} of a top named as an event ("LAD X", "FDO: X", "X (LAD)"),
 * or null. Only the event codes themselves are read here: the loose aliases
 * ("Top", "Base") would turn every formation top into an event.
 */
export function parseEventName(name) {
  const s = String(name ?? '').trim();
  const strict = (w) => {
    const k = String(w).trim().toUpperCase().replace(/[\s-]+/g, '_');
    return BIO_EVENT_CODES.includes(k) ? k : null;
  };
  let m = /^([A-Za-z_]+(?:[ _-][A-Za-z]+)?)\s*:?\s+(.+)$/.exec(s);
  if (m && strict(m[1])) return { event: strict(m[1]), taxon: m[2].trim() };
  m = /^([A-Za-z_]+)\s*:?\s+(.+)$/.exec(s);
  if (m && strict(m[1])) return { event: strict(m[1]), taxon: m[2].trim() };
  m = /^(.+?)\s*\(([^)]+)\)$/.exec(s);
  if (m && strict(m[2])) return { event: strict(m[2]), taxon: m[1].trim() };
  return null;
}

/**
 * The range chart of a well: one column per taxon with its highest and
 * lowest event depth, the events in it, youngest range first (by top).
 * @param {Array<{name, md_m}>} tops the well's tops (events are those whose name parses)
 * @returns {{ taxa: Array<{taxon, top_md_m, base_md_m, events: Array<{event, md_m, name}>, openBelow: boolean, openAbove: boolean}>, events: number }}
 */
export function rangeChart(tops) {
  const byTaxon = new Map();
  let n = 0;
  for (const t of tops || []) {
    const p = parseEventName(t.name);
    if (!p || !Number.isFinite(Number(t.md_m))) continue;
    n += 1;
    const key = p.taxon.toLowerCase();
    if (!byTaxon.has(key)) byTaxon.set(key, { taxon: p.taxon, events: [] });
    byTaxon.get(key).events.push({ event: p.event, md_m: Number(t.md_m), name: t.name, age_ma: Number.isFinite(t.age_ma) ? t.age_ma : null });
  }
  const taxa = [...byTaxon.values()].map((x) => {
    const mds = x.events.map((e) => e.md_m);
    const hasTop = x.events.some((e) => bioEvent(e.event).top);
    const hasBase = x.events.some((e) => !bioEvent(e.event).top);
    return { taxon: x.taxon, top_md_m: Math.min(...mds), base_md_m: Math.max(...mds), events: x.events.sort((a, b) => a.md_m - b.md_m), openAbove: !hasTop, openBelow: !hasBase };
  }).sort((a, b) => a.top_md_m - b.top_md_m || a.taxon.localeCompare(b.taxon));
  return { taxa, events: n };
}

/**
 * The calibrated age of an event from a dictionary of {taxon, event, age_ma}
 * rows. FDO reads the taxon's LAD age and LDO its FAD age when the
 * dictionary has no well-site row (the chronostratigraphic meaning).
 * @returns {?{age_ma: number, row: Object, via: ?string}}
 */
export function dictionaryAge(dict, event, taxon) {
  const tx = String(taxon ?? '').trim().toLowerCase();
  const find = (code) => (dict || []).find((r) => String(r.taxon ?? '').trim().toLowerCase() === tx && bioEvent(r.event)?.code === code && Number.isFinite(Number(r.age_ma)));
  const e = bioEvent(event);
  if (!e) return null;
  const direct = find(e.code);
  if (direct) return { age_ma: Number(direct.age_ma), row: direct, via: null };
  if (e.chron && e.chron !== e.code) {
    const alt = find(e.chron);
    if (alt) return { age_ma: Number(alt.age_ma), row: alt, via: e.chron };
  }
  return null;
}

/**
 * Ordinary least squares y = a + b x with the certified-statistics set
 * (NIST StRD definitions): coefficients, their standard deviations, the
 * residual standard deviation (n - 2 degrees of freedom) and R-squared.
 * Centred sums keep it accurate on offset data.
 * @returns {{a, b, se_a, se_b, sd, r2, n, residuals: number[]}}
 */
export function leastSquaresLine(xs, ys) {
  const n = xs.length;
  if (n !== ys.length) throw new Error('x and y differ in length.');
  if (n < 2) throw new Error('A line needs at least two points.');
  let mx = 0; let my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxx = 0; let sxy = 0; let syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx; const dy = ys[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  if (!(sxx > 0)) throw new Error('Every point is at the same depth; no line can be fitted.');
  const b = sxy / sxx;
  const a = my - b * mx;
  const residuals = xs.map((x, i) => ys[i] - (a + b * x));
  const rss = residuals.reduce((s, r) => s + r * r, 0);
  const dof = n - 2;
  const sd = dof > 0 ? Math.sqrt(rss / dof) : 0;
  const se_b = dof > 0 ? sd / Math.sqrt(sxx) : 0;
  const se_a = dof > 0 ? sd * Math.sqrt(1 / n + (mx * mx) / sxx) : 0;
  const r2 = syy > 0 ? 1 - rss / syy : 1;
  return { a, b, se_a, se_b, sd, r2, n, residuals };
}

/**
 * The event-based age model of a well.
 * @param {Array<{name, md_m, age_ma}>} points dated events (md_m already the vertical depth when the caller wants rates vertical)
 * @param {{ breaks?: number[] }} [opts] depths of unconformities: the line restarts below each
 * @returns {{ segments: Array<{from_md_m, to_md_m, a, b, rate_m_per_ma, se_a, se_b, sd, r2, n}>, points: Array<{name, md_m, age_ma, model_ma, residual_ma, flagged: boolean, segment: number}>, skipped: Array<{name, reason}>, ageAt: (md: number) => ?number }}
 */
export function eventAgeModel(points, { breaks = [] } = {}) {
  const skipped = [];
  const ok = [];
  for (const p of points || []) {
    if (!Number.isFinite(Number(p.md_m))) { skipped.push({ name: p.name, reason: 'no depth' }); continue; }
    if (!Number.isFinite(Number(p.age_ma))) { skipped.push({ name: p.name, reason: 'no age' }); continue; }
    ok.push({ ...p, md_m: Number(p.md_m), age_ma: Number(p.age_ma) });
  }
  ok.sort((a, b) => a.md_m - b.md_m);
  const cuts = [...new Set((breaks || []).filter(Number.isFinite))].sort((a, b) => a - b);
  const segOf = (md) => cuts.filter((c) => md > c).length;
  const groups = new Map();
  for (const p of ok) { const s = segOf(p.md_m); if (!groups.has(s)) groups.set(s, []); groups.get(s).push(p); }
  const segments = [];
  const out = [];
  for (const [s, pts] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const from = s === 0 ? -Infinity : cuts[s - 1];
    const to = s < cuts.length ? cuts[s] : Infinity;
    if (pts.length < 2 || new Set(pts.map((p) => p.md_m)).size < 2) {
      for (const p of pts) skipped.push({ name: p.name, reason: 'the only dated depth in its segment (a line needs two)' });
      continue;
    }
    const fit = leastSquaresLine(pts.map((p) => p.md_m), pts.map((p) => p.age_ma));
    const idx = segments.length;
    segments.push({ from_md_m: from, to_md_m: to, a: fit.a, b: fit.b, rate_m_per_ma: fit.b > 0 ? 1 / fit.b : null, se_a: fit.se_a, se_b: fit.se_b, sd: fit.sd, r2: fit.r2, n: fit.n, inverted: !(fit.b > 0) });
    pts.forEach((p, i) => out.push({ name: p.name, md_m: p.md_m, age_ma: p.age_ma, model_ma: fit.a + fit.b * p.md_m, residual_ma: fit.residuals[i], flagged: fit.n > 2 && fit.sd > 0 && Math.abs(fit.residuals[i]) > 2 * fit.sd, segment: idx }));
  }
  const ageAt = (md) => {
    const seg = segments.find((g) => md > g.from_md_m && md <= g.to_md_m) || segments.find((g) => md >= g.from_md_m && md <= g.to_md_m);
    return seg ? seg.a + seg.b * md : null;
  };
  return { segments, points: out.sort((a, b) => a.md_m - b.md_m), skipped, ageAt };
}
