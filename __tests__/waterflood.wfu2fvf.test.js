// Waterflood Design Studio upgrade, Step 2 (WF-U2-008): FVF by period in the
// surveillance voidage. computeFieldVRR takes config.fvf_by_date, a set of
// Bo, Bw, Bg and Rs per field date read at that date's reservoir pressure.
// The gate calls both engines: a monthly history with a per-period set gives
// the cumulative voidage and VRR of the VRR Monitor core (computeVRRSeries,
// vrr.js, with per-period overrides) to 1e-12. Invariant: a track equal to
// the single set changes nothing, bit for bit. Negative control: the single
// set misses the per-period answer.
import { analyzeWaterflood } from '../engines/waterflood/waterflood.js';
import { computeVRRSeries } from '../engines/waterflood/vrr.js';

const months = ['2025-01-01', '2025-02-01', '2025-03-01', '2025-04-01', '2025-05-01'];
const days = [31, 28, 31, 30, 31];
const vols = months.map((m, i) => ({ Np: 30000 - 2000 * i, Wp: 6000 + 3000 * i, Gp: 21000 - 1000 * i, Wi: 40000 + 1500 * i }));
// a rate row per month whose calendar weight is the days to the next month
// (the last month: the gap before it, 30 days), so volume = rate x weight
const weights = [31, 28, 31, 30, 30];
const rows = [];
months.forEach((date, i) => {
  rows.push({ date, well: 'P', oil_bbl: vols[i].Np / weights[i], water_bbl: vols[i].Wp / weights[i], gas_mcf: vols[i].Gp / weights[i] });
  rows.push({ date, well: 'I', inj_bbl: vols[i].Wi / weights[i] });
});
const base = { bo: 1.25, bw: 1.02, bg: 0.9, rs: 550, time_weighting: 'calendar' };
// pressure falling from 2,800 to 2,400 psia: Bo shrinks, Bg grows, Rs falls (illustrative values)
const track = {
  '2025-01-01': { Bo: 1.30, Bw: 1.020, Bg: 0.85, Rs: 600 },
  '2025-02-01': { Bo: 1.29, Bw: 1.021, Bg: 0.88, Rs: 585 },
  '2025-03-01': { Bo: 1.28, Bw: 1.022, Bg: 0.91, Rs: 570 },
  '2025-04-01': { Bo: 1.27, Bw: 1.023, Bg: 0.95, Rs: 555 },
  '2025-05-01': { Bo: 1.26, Bw: 1.024, Bg: 0.99, Rs: 540 },
};

describe('FVF by period in the surveillance voidage', () => {
  it('equals the VRR Monitor core with the same per-period sets to 1e-12', () => {
    const wf = analyzeWaterflood(rows, { ...base, fvf_by_date: track });
    const vrr = computeVRRSeries(months.map((m, i) => ({ ...vols[i], ...track[m] })), { Bo: 1.25, Bw: 1.02, Bg: 0.9, Rs: 550 });
    const last = vrr[vrr.length - 1];
    expect(Math.abs(wf.kpis.cum_produced_voidage_rb - last.cumProd) / last.cumProd).toBeLessThan(1e-12);
    expect(Math.abs(wf.kpis.cum_injected_voidage_rb - last.cumInj) / last.cumInj).toBeLessThan(1e-12);
    expect(Math.abs(wf.kpis.vrr_avg - last.cumulativeVRR)).toBeLessThan(1e-12);
  });

  it('a track equal to the single set changes nothing, bit for bit; a partial entry keeps the rest', () => {
    const same = Object.fromEntries(months.map((m) => [m, { Bo: 1.25, Bw: 1.02, Bg: 0.9, Rs: 550 }]));
    expect(analyzeWaterflood(rows, { ...base, fvf_by_date: same }).vrr_series).toEqual(analyzeWaterflood(rows, base).vrr_series);
    const partial = analyzeWaterflood(rows, { ...base, fvf_by_date: { '2025-03-01': { Bo: 1.4, Bw: NaN } } });
    const vrr = computeVRRSeries(months.map((m, i) => ({ ...vols[i], ...(m === '2025-03-01' ? { Bo: 1.4 } : {}) })), { Bo: 1.25, Bw: 1.02, Bg: 0.9, Rs: 550 });
    expect(Math.abs(partial.kpis.cum_produced_voidage_rb - vrr[vrr.length - 1].cumProd) / vrr[vrr.length - 1].cumProd).toBeLessThan(1e-12);
  });

  it('negative control: the single set misses the per-period answer', () => {
    const one = analyzeWaterflood(rows, base);
    const vrr = computeVRRSeries(months.map((m, i) => ({ ...vols[i], ...track[m] })), { Bo: 1.25, Bw: 1.02, Bg: 0.9, Rs: 550 });
    expect(Math.abs(one.kpis.cum_produced_voidage_rb - vrr[vrr.length - 1].cumProd) / vrr[vrr.length - 1].cumProd).toBeGreaterThan(1e-3);
  });
});
