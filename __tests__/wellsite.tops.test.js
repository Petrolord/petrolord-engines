/** WS5 tops: the lifecycle, chains and conflicts, the approach panel against the depth engine, the publish shape. */
import { TOP_TRANSITIONS, canTransition, formationKey, chainHeads, versionChain, currentCall, currentInterpretation, topConflicts, approachPanel, toRegistryTop } from '../engines/wellsite/tops';
import { mdToTvd } from '../engines/wellsite/depth';

const near = (a, b, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);
const row = (id, o) => ({ id, chain_id: o.chain || id, version_no: o.v || 1, previous_version_id: o.prev || null, resolves_ids: o.resolves || null, role: o.role || 'official', status: o.status || 'preliminary', formation_key: o.key || 'agbada', name: 'Agbada', occurred_at: o.at || '2026-09-07T00:00:00Z', md_calc_m: o.md || 3000, confidence: o.conf || null, basis: o.basis || null });

test('statuses and transitions', () => {
  expect(Object.keys(TOP_TRANSITIONS)).toEqual(['preliminary', 'confirmed', 'revised', 'withdrawn', 'final']);
  expect(canTransition(null, 'preliminary').ok).toBe(true);
  expect(canTransition(null, 'final')).toEqual({ ok: false, reason: 'A first call is preliminary or confirmed.' });
  expect(canTransition('preliminary', 'final')).toEqual({ ok: false, reason: 'A preliminary top cannot go straight to final.' });
  expect(canTransition('confirmed', 'final').ok).toBe(true);
  expect(canTransition('final', 'revised').ok).toBe(true);
  expect(canTransition('withdrawn', 'preliminary').ok).toBe(true);
  expect(canTransition('withdrawn', 'final').ok).toBe(false);
  expect(canTransition('confirmed', 'sure').reason).toBe('Unknown top status sure.');
  expect(formationKey(' Top Agbada (B4000) ')).toBe('top_agbada_b4000');
});

test('chains, heads, current call and interpretation, competing heads', () => {
  const v1 = row('a1', { status: 'preliminary' });
  const v2 = row('a2', { chain: 'a1', v: 2, prev: 'a1', status: 'confirmed', at: '2026-09-07T01:00:00Z' });
  const v3 = row('a3', { chain: 'a1', v: 3, prev: 'a2', status: 'final', at: '2026-09-07T02:00:00Z' });
  expect(versionChain([v3, v1, v2], 'a1').map((r) => r.id)).toEqual(['a1', 'a2', 'a3']);
  expect(chainHeads([v1, v2, v3]).map((r) => r.id)).toEqual(['a3']);
  expect(currentCall([v1, v2, v3], 'agbada').call.id).toBe('a3');
  // a competing branch from v2 by the office
  const b3 = row('b3', { chain: 'a1', v: 3, prev: 'a2', status: 'confirmed', at: '2026-09-07T02:30:00Z', md: 3005 });
  const cc = currentCall([v1, v2, v3, b3], 'agbada');
  expect(cc.competing.map((r) => r.id).sort()).toEqual(['a3', 'b3']);
  expect(topConflicts([v1, v2, v3, b3])).toEqual([{ kind: 'chain_heads', chainId: 'a1', formationKey: 'agbada', headIds: ['a3', 'b3'] }]);
  // the approver resolves both
  const r4 = row('r4', { chain: 'a1', v: 4, prev: 'a3', resolves: ['a3', 'b3'], status: 'final', at: '2026-09-07T03:00:00Z' });
  expect(topConflicts([v1, v2, v3, b3, r4])).toEqual([]);
  expect(currentCall([v1, v2, v3, b3, r4], 'agbada').call.id).toBe('r4');
  // two finals on different chains for one formation
  const other = row('z1', { status: 'final', at: '2026-09-07T04:00:00Z' });
  expect(topConflicts([v1, v2, v3, b3, r4, other])).toEqual([{ kind: 'dual_final', chainId: null, formationKey: 'agbada', headIds: ['r4', 'z1'] }]);
  // withdrawn calls are not current
  const w = row('w1', { key: 'benin', status: 'withdrawn' });
  expect(currentCall([w], 'benin')).toEqual({ call: null, competing: [] });
  const i1 = row('i1', { role: 'interpretation', conf: 'high' });
  expect(currentInterpretation([i1, v1], 'agbada').interpretation.id).toBe('i1');
});

test('approach panel: distances in MD and TVD, the window, offsets, and the wording', () => {
  const ctx = { kbElevM: 25, survey: { version: 'v1', stations: [{ md: 0, inc: 0, azi: 0 }, { md: 1400, inc: 0, azi: 0 }, { md: 1750, inc: 30, azi: 90 }, { md: 3200, inc: 30, azi: 90 }] } };
  const prognosis = { mdM: 3100, uncertaintyM: 20 };
  const p = approachPanel({ formation: 'Agbada', prognosis, bitMdM: 3050, ctx, offsetTops: [{ well: 'KETA-1', tvdssM: 2650 }, { well: 'KETA-3', tvdssM: 2670 }] });
  near(p.distanceMdM, 50);
  near(p.distanceTvdM, mdToTvd(3100, ctx).tvdM - mdToTvd(3050, ctx).tvdM);
  expect(p.distanceTvdM).toBeLessThan(50);
  expect(p.inWindow).toBe(false);
  expect(p.text).toBe('Bit is 50 m MD above the prognosed Agbada, 30 m above its 20 m uncertainty window.');
  expect(p.offset).toEqual({ n: 2, meanTvdssM: 2660, minTvdssM: 2650, maxTvdssM: 2670, spreadM: 20 });
  expect(approachPanel({ formation: 'Agbada', prognosis, bitMdM: 3090, ctx }).text).toBe('Bit is 10 m MD from the prognosed Agbada, inside the 20 m uncertainty window.');
  expect(approachPanel({ formation: 'Agbada', prognosis, bitMdM: 3130, ctx }).text).toBe('Bit is 10 m MD below the 20 m uncertainty window of Agbada and no top has been called.');
  expect(approachPanel({ formation: 'Agbada', prognosis: null, bitMdM: 3130, ctx }).text).toBe('Agbada has no prognosis depth.');
  expect(approachPanel({ formation: 'Agbada', prognosis, bitMdM: null, ctx }).text).toBe('No bit depth recorded; Agbada is prognosed at 3100 m MD.');
});

test('the publish shape needs an official final call', () => {
  const call = row('f1', { status: 'final', conf: 'high', basis: 'GR drop and sand at 10,208 ft', v: 3 });
  expect(toRegistryTop(call, { interpreterName: 'A. Geologist' })).toEqual({ name: 'Agbada', md_m: 3000, surface_type: 'formation_top', confidence: 'high', unit_id: null, interpreter: 'A. Geologist', notes: 'Wellsite Studio ws-1.0.0 | top f1 v3 | GR drop and sand at 10,208 ft' });
  expect(() => toRegistryTop(row('p', { status: 'confirmed' }))).toThrow('Only a final call publishes to the registry.');
  expect(() => toRegistryTop(row('i', { role: 'interpretation', status: 'final' }))).toThrow('Only an official call publishes to the registry.');
});
