// Prospect integration for a QI study (QI programme Q10, SOW section 11).
// Three pieces sit on the closure engine (lib/gridding/closure.js: crest,
// spill point, closure and GRV at any contact):
//  - conformance: whether an amplitude anomaly fits the structure. A
//    hydrocarbon anomaly ends downdip at a contact, so its downdip edge
//    follows one depth contour (the classic DHI conformance check; Roden,
//    Forrest and Holeywell 2005, The Leading Edge 24(7), and the Rose and
//    Associates DHI consortium checklist). Measured here as the scatter of
//    the edge's elevations against the closure's relief, the share of the
//    anomaly inside the closure, and the contact the edge implies;
//  - evidence independence: two attributes computed from one seismic
//    response (an RMS amplitude and an impedance from the same full stack)
//    are one piece of evidence, not two;
//  - the assessment: a decision table from the evidence to mature, retain,
//    investigate or downgrade. The absence of an anomaly lowers confidence
//    only when the feasibility study says the case would be visible. QI
//    never sets the geological chance: it reports what the seismic says for
//    the risk team to weigh.
// Pure, float64.

import { closureAt } from '../../lib/gridding/closure.js';
import { isNull } from '../../lib/gridding/gridmath.js';

const fin = Number.isFinite;

/**
 * Conformance of an anomaly to the structure of one trap.
 * @param {Object} p
 * @param {ArrayLike<number>} p.z elevation grid (m, negative down; nulls allowed)
 * @param {{nx, ny}} p.spec
 * @param {ArrayLike<number>} p.mask 1 inside the anomaly, 0 outside (same grid)
 * @param {Object} p.spill spillAnalysis of the trap
 * @param {{x0,y0,dx,dy,nx,ny}} p.frame the frame for closureAt (usually p.spec)
 * @returns {{edgeNodes: number, impliedContactZ: number, edgeSdM: number, reliefM: number,
 *   conformance: number, insideClosure: number, anomalyNodes: number,
 *   impliedVsSpillM: number, grvAtImpliedM3: number, grvAtSpillM3: number}}
 *   conformance = 1 - edge scatter / relief, clipped to 0..1; insideClosure is
 *   the share of anomaly nodes inside the closure at its spill point
 */
export function anomalyConformance({ z, spec, mask, spill, frame = spec }) {
  const { nx, ny } = spec;
  if (z.length !== nx * ny || mask.length !== nx * ny) throw new Error('The surface and the anomaly must share one grid.');
  const atSpill = closureAt(spill, frame, spill.spillZ);
  const inClosure = new Uint8Array(nx * ny);
  for (let k = 0; k < atSpill.nodes; k++) inClosure[spill.order[k]] = 1;
  const reliefM = spill.crest.z - spill.spillZ;
  let anomalyNodes = 0; let inside = 0;
  const edge = [];
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const i = r * nx + c;
      if (!(mask[i] > 0) || isNull(z[i])) continue;
      anomalyNodes += 1;
      if (inClosure[i]) inside += 1;
      // a downdip edge: an anomaly node beside a lower node outside it (not the map
      // edge); the contact lies between the two, so the edge is read at their midpoints
      let s = 0; let k = 0;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const rr = r + dr; const cc = c + dc;
        if (rr < 0 || rr >= ny || cc < 0 || cc >= nx) continue;
        const j = rr * nx + cc;
        if (!(mask[j] > 0) && !isNull(z[j]) && z[j] < z[i]) { s += (z[i] + z[j]) / 2; k += 1; }
      }
      if (k) edge.push(s / k);
    }
  }
  if (!anomalyNodes) throw new Error('The anomaly has no mapped nodes on the surface.');
  const n = edge.length;
  const mean = n ? edge.reduce((a, v) => a + v, 0) / n : NaN;
  const sd = n > 1 ? Math.sqrt(edge.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : NaN;
  const conformance = fin(sd) && reliefM > 0 ? Math.min(1, Math.max(0, 1 - sd / reliefM)) : NaN;
  const implied = fin(mean) ? Math.max(mean, spill.spillZ) : NaN; // a contact cannot sit below the spill
  return {
    edgeNodes: n,
    impliedContactZ: mean,
    edgeSdM: sd,
    reliefM,
    conformance,
    insideClosure: inside / anomalyNodes,
    anomalyNodes,
    impliedVsSpillM: fin(mean) ? mean - spill.spillZ : NaN,
    grvAtImpliedM3: fin(implied) ? closureAt(spill, frame, implied).grvM3 : NaN,
    grvAtSpillM3: atSpill.grvM3,
  };
}

/** The seismic responses an attribute can come from; attributes from one response are one piece of evidence. */
export const EVIDENCE_SOURCES = Object.freeze({
  full_stack: 'Full-stack amplitude (and attributes or impedance from it)',
  near_stack: 'Near-angle stack',
  far_stack: 'Far-angle stack',
  avo: 'AVO from gathers or partial stacks (intercept, gradient, fluid factor)',
  elastic_inversion: 'Prestack inversion (Vp/Vs, density)',
  frequency: 'Frequency or attenuation attributes',
  well: 'Well results (shows, tests, logs)',
  other: 'Other data (CSEM, seeps, gravity)',
});

/**
 * Group evidence items by the response they come from.
 * @param {Array<{name: string, source: string, supports?: boolean}>} items
 * @returns {{independent: number, supporting: number, groups: Array<{source, label, items: string[]}>, shared: Array<{source, items: string[]}>}}
 *   independent counts the distinct sources among supporting items; shared lists sources with two or more items
 */
export function evidenceIndependence(items) {
  const bySource = new Map();
  for (const it of items || []) {
    const src = EVIDENCE_SOURCES[it.source] ? it.source : 'other';
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src).push(it);
  }
  const groups = [...bySource].map(([source, list]) => ({ source, label: EVIDENCE_SOURCES[source], items: list.map((x) => x.name) }));
  const supportingSources = new Set([...bySource].filter(([, list]) => list.some((x) => x.supports !== false)).map(([s]) => s));
  return {
    independent: supportingSources.size,
    supporting: (items || []).filter((x) => x.supports !== false).length,
    groups,
    shared: groups.filter((g) => g.items.length > 1).map((g) => ({ source: g.source, items: g.items })),
  };
}

export const RECOMMENDATIONS = Object.freeze({
  mature: 'Mature: the QI evidence supports the prospect; carry it to volumetrics and risking',
  retain: 'Retain: the QI says little either way; keep the prospect on its geology',
  investigate: 'Investigate: an anomaly is there but unproven; resolve the open points first',
  downgrade: 'Downgrade: the QI argues against the prospect',
});

/**
 * The per-prospect QI assessment (the decision table). Thresholds:
 * conformance 0.7 and above fits, under 0.3 cuts across the structure;
 * at least two independent supporting sources to mature.
 * @param {Object} a
 * @param {boolean} a.anomalyPresent
 * @param {?number} a.conformance from anomalyConformance (null when no anomaly)
 * @param {?number} a.insideClosure
 * @param {number} a.independent from evidenceIndependence
 * @param {'feasible'|'conditional'|'not-feasible'|''} a.feasibility the target's verdict (Package 1)
 * @param {Array<{name, status: 'open'|'ruled-out'|'likely'}>} a.competing competing explanations
 * @returns {{recommendation: string, label: string, seismicSupport: 'supports'|'neutral'|'against', reasons: string[]}}
 */
export function assessProspect({ anomalyPresent, conformance = null, insideClosure = null, independent = 0, feasibility = '', competing = [] }) {
  const reasons = [];
  const detectable = feasibility === 'feasible' || feasibility === 'conditional';
  const likelyAlt = competing.filter((c) => c.status === 'likely').map((c) => c.name);
  const openAlt = competing.filter((c) => c.status === 'open').map((c) => c.name);
  const out = (recommendation, seismicSupport) => ({ recommendation, label: RECOMMENDATIONS[recommendation], seismicSupport, reasons });
  if (!anomalyPresent) {
    if (feasibility === 'feasible') {
      reasons.push('No anomaly where the feasibility study says the hydrocarbon case would be visible.');
      return out('downgrade', 'against');
    }
    reasons.push(detectable
      ? 'No anomaly, and the feasibility study says the case is visible only under conditions: the absence weighs little.'
      : 'No anomaly, but the feasibility study does not say the case would be visible: the absence is not evidence.');
    return out('retain', 'neutral');
  }
  if (likelyAlt.length) {
    reasons.push(`A competing explanation is judged likely: ${likelyAlt.join(', ')}.`);
    return out(fin(conformance) && conformance < 0.3 ? 'downgrade' : 'investigate', fin(conformance) && conformance < 0.3 ? 'against' : 'neutral');
  }
  if (fin(conformance) && conformance < 0.3) {
    reasons.push(`The anomaly cuts across the structure (conformance ${conformance.toFixed(2)}).`);
    return out('investigate', 'neutral');
  }
  if (fin(insideClosure) && insideClosure < 0.5) reasons.push(`Only ${Math.round(100 * insideClosure)} percent of the anomaly lies inside the closure.`);
  if (!fin(conformance) || conformance < 0.7) reasons.push(fin(conformance) ? `Conformance ${conformance.toFixed(2)} is short of a fit (0.7).` : 'Conformance could not be measured.');
  if (independent < 2) reasons.push(`${independent} independent supporting source${independent === 1 ? '' : 's'}; two are needed to mature.`);
  if (openAlt.length) reasons.push(`Competing explanations still open: ${openAlt.join(', ')}.`);
  if (!detectable) reasons.push('The feasibility study does not say the case is visible: the anomaly may not be the hydrocarbon response.');
  if (!reasons.length) {
    reasons.push(`The anomaly fits the structure (conformance ${conformance.toFixed(2)}), with ${independent} independent supporting sources and no competing explanation left open.`);
    return out('mature', 'supports');
  }
  return out('investigate', 'supports');
}
