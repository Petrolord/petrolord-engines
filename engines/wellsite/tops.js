// Wellsite Studio WS5: formation tops (spec sections 23 to 26). An
// interpretation says what the evidence suggests (a depth range and a
// confidence); a decision is the official call at one depth with a
// status. Each is a version chain; nothing is overwritten. The approach
// panel puts the prognosis, the offsets and the bit side by side and
// presents them; the person makes the call.

import { mdToTvd } from './depth.js';

export const TOP_STATUSES = Object.freeze(['preliminary', 'confirmed', 'revised', 'withdrawn', 'final']);
export const TOP_TRANSITIONS = Object.freeze({
  preliminary: ['confirmed', 'revised', 'withdrawn'],
  confirmed: ['revised', 'withdrawn', 'final'],
  revised: ['confirmed', 'withdrawn', 'final'],
  withdrawn: ['preliminary'],
  final: ['revised', 'withdrawn'],
});
export const CONFIDENCES = Object.freeze(['low', 'medium', 'high']);

export function formationKey(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function canTransition(from, to) {
  if (!from) return { ok: to === 'preliminary' || to === 'confirmed', reason: to === 'preliminary' || to === 'confirmed' ? '' : 'A first call is preliminary or confirmed.' };
  if (!TOP_STATUSES.includes(to)) return { ok: false, reason: `Unknown top status ${to}.` };
  const ok = (TOP_TRANSITIONS[from] || []).includes(to);
  return { ok, reason: ok ? '' : `A ${from} top cannot go straight to ${to}.` };
}

/** Heads of version chains (nothing names them as previous, no resolver cites them). */
export function chainHeads(rows) {
  const prev = new Set();
  const resolved = new Set();
  for (const r of rows) {
    if (r.previous_version_id) prev.add(r.previous_version_id);
    for (const id of r.resolves_ids || []) resolved.add(id);
  }
  return rows.filter((r) => !prev.has(r.id) && !resolved.has(r.id));
}

/** The chain of one top in version order. */
export function versionChain(rows, chainId) {
  return rows.filter((r) => r.chain_id === chainId).sort((a, b) => (a.version_no || 1) - (b.version_no || 1));
}

/** The current official call of a formation: the head official row that is not withdrawn (null if none, list if competing). */
export function currentCall(rows, key) {
  const heads = chainHeads(rows.filter((r) => r.role === 'official' && r.formation_key === key)).filter((r) => r.status !== 'withdrawn');
  if (!heads.length) return { call: null, competing: [] };
  heads.sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));
  return { call: heads[0], competing: heads.length > 1 ? heads : [] };
}

export function currentInterpretation(rows, key) {
  const heads = chainHeads(rows.filter((r) => r.role === 'interpretation' && r.formation_key === key));
  heads.sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));
  return { interpretation: heads[0] || null, competing: heads.length > 1 ? heads : [] };
}

/** Conflicts among tops: two heads on a chain, or two final official calls for one formation. */
export function topConflicts(rows) {
  const out = [];
  const byChain = new Map();
  for (const r of rows) { if (!byChain.has(r.chain_id)) byChain.set(r.chain_id, []); byChain.get(r.chain_id).push(r); }
  for (const [chainId, list] of byChain) {
    const heads = chainHeads(list);
    if (heads.length > 1) out.push({ kind: 'chain_heads', chainId, formationKey: list[0].formation_key, headIds: heads.map((h) => h.id) });
  }
  const finals = new Map();
  for (const h of chainHeads(rows.filter((r) => r.role === 'official' && r.status === 'final'))) {
    if (!finals.has(h.formation_key)) finals.set(h.formation_key, []);
    finals.get(h.formation_key).push(h.id);
  }
  for (const [key, ids] of finals) if (ids.length > 1) out.push({ kind: 'dual_final', chainId: null, formationKey: key, headIds: ids });
  return out;
}

/**
 * The approach panel model.
 * @param {Object} p { formation, prognosis:{ mdM, uncertaintyM }, bitMdM, ctx, offsetTops:[{ well, tvdssM }], interpretation, call }
 */
export function approachPanel({ formation, prognosis, bitMdM, ctx, offsetTops = [], interpretation = null, call = null }) {
  const out = { formation, prognosisMdM: prognosis ? prognosis.mdM : null, uncertaintyM: prognosis ? prognosis.uncertaintyM || 0 : 0 };
  if (prognosis && Number.isFinite(prognosis.mdM)) {
    const pt = mdToTvd(prognosis.mdM, ctx);
    out.prognosisTvdM = pt.tvdM;
    out.prognosisTvdssM = pt.tvdssM;
    out.window = { fromMdM: prognosis.mdM - out.uncertaintyM, toMdM: prognosis.mdM + out.uncertaintyM };
    if (Number.isFinite(bitMdM)) {
      const bt = mdToTvd(bitMdM, ctx);
      out.bitMdM = bitMdM;
      out.bitTvdssM = bt.tvdssM;
      out.distanceMdM = prognosis.mdM - bitMdM;
      out.distanceTvdM = pt.tvdM - bt.tvdM;
      out.inWindow = bitMdM >= out.window.fromMdM && bitMdM <= out.window.toMdM;
      out.passed = bitMdM > out.window.toMdM;
    }
  }
  const tv = offsetTops.map((o) => o.tvdssM).filter(Number.isFinite);
  if (tv.length) {
    const mean = tv.reduce((a, b) => a + b, 0) / tv.length;
    out.offset = { n: tv.length, meanTvdssM: mean, minTvdssM: Math.min(...tv), maxTvdssM: Math.max(...tv), spreadM: Math.max(...tv) - Math.min(...tv) };
  } else out.offset = { n: 0 };
  out.callStatus = call ? call.status : 'none';
  out.interpretationConfidence = interpretation ? interpretation.confidence : null;
  let text;
  if (!prognosis) text = `${formation} has no prognosis depth.`;
  else if (!Number.isFinite(bitMdM)) text = `No bit depth recorded; ${formation} is prognosed at ${prognosis.mdM} m MD.`;
  else if (out.passed) text = `Bit is ${bitMdM - out.window.toMdM} m MD below the ${out.uncertaintyM} m uncertainty window of ${formation}${call ? '' : ' and no top has been called'}.`;
  else if (out.inWindow) text = `Bit is ${out.distanceMdM} m MD from the prognosed ${formation}, inside the ${out.uncertaintyM} m uncertainty window.`;
  else text = `Bit is ${out.distanceMdM} m MD above the prognosed ${formation}, ${out.distanceMdM - out.uncertaintyM} m above its ${out.uncertaintyM} m uncertainty window.`;
  out.text = text;
  return out;
}

/** The registry publish shape of an official final call (geo_wells_tops). */
export function toRegistryTop(call, { interpreterName = null } = {}) {
  if (!call || call.role !== 'official') throw new Error('Only an official call publishes to the registry.');
  if (call.status !== 'final') throw new Error('Only a final call publishes to the registry.');
  return {
    name: call.name, md_m: call.md_calc_m, surface_type: 'formation_top', confidence: call.confidence || null, unit_id: call.unit_id || null,
    interpreter: interpreterName, notes: `Wellsite Studio ws-1.0.0 | top ${call.id} v${call.version_no || 1}${call.basis ? ` | ${call.basis}` : ''}`,
  };
}
