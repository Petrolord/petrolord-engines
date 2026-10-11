// The trap and the anomaly of one prospect in a QI study (QI programme Q10,
// 2026-10-07; SOW section 11; moved from the Suite's
// QIStudio/services/prospects.js on 2026-10-11, QI course gate E2): the trap
// on a depth surface (lib/gridding/closure.js: crest, spill point, closure,
// GRV) found from a picked point by climbing to the local crest, the amplitude
// anomaly from an attribute map and how it fits the structure, the evidence
// and its independence, and the QI assessment (qi/prospectAssessment.js). QI
// never sets the geological chance. Pure.
// Oracle: tools/validation/qi/oracle_qi_prospect_trap.py.

import { spillAnalysis, closureAt } from '../../lib/gridding/closure.js';
import { isNull } from '../../lib/gridding/gridmath.js';
import { anomalyConformance, evidenceIndependence, assessProspect, RECOMMENDATIONS } from './prospectAssessment.js';

/** The node index nearest to a map point (a brute-force scan, once per analysis). */
export function nearestNode(depth, x, y) {
  const { nx, ny } = depth.spec;
  let best = -1; let bd = Infinity;
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const i = r * nx + c;
      if (isNull(depth.grid[i])) continue;
      const p = depth.nodeXY(r, c);
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
  }
  return best;
}

/** From a node, step to the highest of its eight neighbours until none is higher: the local crest. */
export function climbToCrest(z, spec, start) {
  const { nx, ny } = spec;
  let i = start;
  for (let guard = 0; guard < nx * ny; guard++) {
    const r = Math.floor(i / nx); const c = i % nx;
    let next = i;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr; const cc = c + dc;
        if ((dr || dc) && rr >= 0 && rr < ny && cc >= 0 && cc < nx) {
          const j = rr * nx + cc;
          if (!isNull(z[j]) && z[j] > z[next]) next = j;
        }
      }
    }
    if (next === i) return i;
    i = next;
  }
  return i;
}

/** The anomaly on the depth grid: the attribute map read at each node, above (high) or below (low) the threshold. */
export function anomalyMaskOn(depth, attr, { threshold, sense = 'high' }) {
  const { nx, ny } = depth.spec;
  const mask = new Uint8Array(nx * ny);
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const i = r * nx + c;
      if (isNull(depth.grid[i])) continue;
      const p = depth.nodeXY(r, c);
      const v = attr.sampleAt(p.x, p.y);
      if (Number.isFinite(v) && !isNull(v) && (sense === 'low' ? v <= threshold : v >= threshold)) mask[i] = 1;
    }
  }
  return mask;
}

/** Keep the anomaly patches (4-connected) that reach into the closure; the rest belong to other features. */
export function keepTouching(mask, spec, inClosure) {
  const { nx, ny } = spec;
  const out = new Uint8Array(mask.length);
  const seen = new Uint8Array(mask.length);
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    const comp = []; const stack = [s]; seen[s] = 1;
    let touches = false;
    while (stack.length) {
      const i = stack.pop();
      comp.push(i);
      if (inClosure[i]) touches = true;
      const r = Math.floor(i / nx); const c = i % nx;
      for (const [rr, cc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
        if (rr < 0 || rr >= ny || cc < 0 || cc >= nx) continue;
        const j = rr * nx + cc;
        if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (touches) for (const i of comp) out[i] = 1;
  }
  return out;
}

const depthOf = (zElev) => -zElev; // the closure engine works in elevation (negative down)

/**
 * The analysis of one prospect.
 * @param {Object} p
 * @param {Object} p.depth readDepthSurface result as elevation in metres (xy in metres)
 * @param {?Object} p.attr readDepthSurface result of the attribute map, or null for no anomaly
 * @param {{crestX?: number, crestY?: number, anomaly?: {threshold: number, sense: 'high'|'low'}|null,
 *   evidence?: Array, competing?: Array}} p.prospect
 * @param {string} p.feasibility the target's Package 1 verdict
 */
export function analyseProspect({ depth, attr, prospect, feasibility = '' }) {
  const z = Float64Array.from(depth.grid);
  const spec = depth.spec;
  let seed = null;
  if (Number.isFinite(prospect.crestX) && Number.isFinite(prospect.crestY)) {
    const n = nearestNode(depth, prospect.crestX, prospect.crestY);
    if (n < 0) throw new Error('The surface has no mapped node near that point.');
    seed = climbToCrest(z, spec, n);
  }
  const spill = spillAnalysis(z, spec, seed == null ? {} : { seed });
  const atSpill = closureAt(spill, spec, spill.spillZ);
  const inClosure = new Uint8Array(z.length);
  for (let k = 0; k < atSpill.nodes; k++) inClosure[spill.order[k]] = 1;
  const trap = {
    crest: { x: spill.crest.x, y: spill.crest.y, depthM: depthOf(spill.crest.z) },
    spill: { x: spill.spill.x, y: spill.spill.y, depthM: depthOf(spill.spillZ) },
    columnM: spill.crest.z - spill.spillZ,
    areaKm2: atSpill.areaM2 / 1e6,
    grvSpillM3: atSpill.grvM3,
    limitedByEdge: spill.limitedByEdge,
    merges: spill.merges.length,
  };
  let anomaly = null;
  if (attr && prospect.anomaly) {
    const mask = keepTouching(anomalyMaskOn(depth, attr, prospect.anomaly), spec, inClosure);
    let any = false;
    for (const v of mask) if (v) { any = true; break; }
    if (any) {
      const c = anomalyConformance({ z, spec, mask, spill });
      // a contact cannot sit below the spill: the edge mean is held there, as the GRV is
      const heldZ = Number.isFinite(c.impliedContactZ) ? Math.max(c.impliedContactZ, spill.spillZ) : NaN;
      anomaly = {
        nodes: c.anomalyNodes,
        areaKm2: (c.anomalyNodes * Math.abs(spec.dx * spec.dy)) / 1e6,
        conformance: c.conformance,
        edgeSdM: c.edgeSdM,
        insideClosure: c.insideClosure,
        impliedContactDepthM: Number.isFinite(heldZ) ? depthOf(heldZ) : null,
        edgeBelowSpillM: Number.isFinite(c.impliedVsSpillM) && c.impliedVsSpillM < 0 ? -c.impliedVsSpillM : 0,
        impliedAboveSpillM: c.impliedVsSpillM,
        grvImpliedM3: c.grvAtImpliedM3,
      };
    }
  }
  const evidence = evidenceIndependence(prospect.evidence || []);
  const assessment = assessProspect({
    anomalyPresent: !!anomaly,
    conformance: anomaly ? anomaly.conformance : null,
    insideClosure: anomaly ? anomaly.insideClosure : null,
    independent: evidence.independent,
    feasibility,
    competing: (prospect.competing || []).map((c) => ({ name: c.name, status: c.status })),
  });
  if (anomaly?.edgeBelowSpillM > 0) assessment.reasons.push(`The anomaly edge averages ${anomaly.edgeBelowSpillM.toFixed(0)} m below the spill point; the contact is held at the spill, so the anomaly runs past the closure there.`);
  if (trap.limitedByEdge) {
    assessment.reasons.push('The spill point lies on the edge of the mapped area: the trap may continue off the map, so its GRV at spill is a lower bound.');
    // a contact the anomaly implies above the spill keeps its GRV closed on the map; an
    // anomaly filled to the edge spill does not, so it waits for the map to cover the spill
    const filledToSpill = !(anomaly && anomaly.impliedAboveSpillM > 0);
    if (filledToSpill && assessment.recommendation === 'mature') {
      assessment.recommendation = 'investigate';
      assessment.label = RECOMMENDATIONS.investigate;
      assessment.reasons.push('Held at investigate: the anomaly fills the trap to a spill on the map edge, so its volume is open until the map covers the spill point.');
    }
  }
  return { trap, anomaly, evidence, assessment };
}
