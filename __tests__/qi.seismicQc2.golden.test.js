/**
 * Seismic QC on arbitrary traces against its independent oracle (QI course
 * gate E1c, G6): tools/validation/qi/oracle_qi_seismic_qc2.py (stdlib;
 * Harris's Tukey window, a direct DFT, the Hatton coherency S/N on seeded
 * traces with a known realised S/N, a direct-DFT footprint periodogram).
 * Every assertion calls the shipped engine.
 */
import G from '../test-data/qi/goldens.seismicQc2.json';
import { amplitudeSpectrum, averageSpectrum, spectrumStats, snrFromCoherency, footprint } from '../engines/qi/seismicQc';

const nan = (a) => a.map((v) => (v === null ? NaN : v));
const rel = (got, want, tol) => expect(Math.abs(got - want)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(want)));
const statsMatch = (s, o, tol = 1e-9) => {
  rel(s.peakHz, o.peakHz, tol); rel(s.peakAmp, o.peakAmp, tol); rel(s.centroidHz, o.centroidHz, tol);
  rel(s.band6[0], o.band6[0], tol); rel(s.band6[1], o.band6[1], tol);
  rel(s.band20[0], o.band20[0], tol); rel(s.band20[1], o.band20[1], tol);
};

describe('spectrum of arbitrary traces', () => {
  test.each(G.spectra.map((c) => [c.name, c]))('%s: amplitudes and statistics match the direct DFT', (_, c) => {
    const s = amplitudeSpectrum(nan(c.trace), c.dtMs, { taper: c.taper });
    expect(s.amp.length).toBe(c.nBins);
    rel(s.df, c.df, 1e-15);
    c.ampEvery16.forEach((a, j) => rel(s.amp[16 * j], a, 1e-10));
    statsMatch(spectrumStats(s), c.stats);
  });
  test('every bin -6 dB edge sits within one bin of the continuous transform', () => {
    for (const c of G.spectra) {
      const st = spectrumStats(amplitudeSpectrum(nan(c.trace), c.dtMs, { taper: c.taper }));
      expect(Math.abs(st.band6[0] - c.continuous6[0])).toBeLessThan(c.df);
      expect(Math.abs(st.band6[1] - c.continuous6[1])).toBeLessThan(c.df);
    }
  });
  test('the average spectrum of a trace patch: power mean, -6 dB low edge and centroid', () => {
    const a = averageSpectrum(G.average.traces, G.average.dtMs, { taper: G.average.taper });
    expect(a.traces).toBe(G.average.traces.length);
    G.average.ampEvery16.forEach((v, j) => rel(a.amp[16 * j], v, 1e-10));
    statsMatch(spectrumStats(a), G.average.stats);
  });
  test('C1 convention: where alpha (n - 1) / 2 is not whole the floor taper moves the edges by under 0.05 Hz', () => {
    const c = G.taperConvention;
    const st = spectrumStats(amplitudeSpectrum(c.trace, c.dtMs, { taper: c.taper }));
    const d = Math.max(...[0, 1].map((k) => Math.abs(st.band6[k] - c.harrisStats.band6[k])));
    expect(d).toBeGreaterThan(0); // the conventions do differ
    expect(d).toBeLessThan(0.05);
    expect(Math.abs(st.centroidHz - c.harrisStats.centroidHz)).toBeLessThan(0.05);
    statsMatch(st, c.onSampleStats); // and the engine is exactly its stated convention (W = floor)
  });
  test('negative control: the untapered spectrum of a tapered case misses the gate', () => {
    const c = G.spectra[1];
    const st = spectrumStats(amplitudeSpectrum(nan(c.trace), c.dtMs, { taper: 0 }));
    const off = Math.abs(st.centroidHz - c.stats.centroidHz) + Math.abs(st.band6[0] - c.stats.band6[0]);
    expect(off).toBeGreaterThan(1e-6);
  });
});

describe('signal to noise from coherency', () => {
  test.each(G.snr.map((c, k) => [k, c]))('case %s: per pair and the median', (_, c) => {
    const r = snrFromCoherency(c.traces.map(nan), { maxLag: c.maxLag });
    expect(r.pairs).toBe(c.out.pairs);
    c.out.perPair.forEach((v, j) => rel(r.perPair[j], v, 1e-9));
    rel(r.snr, c.out.snr, 1e-9);
    if (c.out.snrDb === null) expect(r.snrDb).toBe(-Infinity); else rel(r.snrDb, c.out.snrDb, 1e-9);
  });
  test('the estimate tracks the realised S/N where the lag search covers the dip', () => {
    for (const c of G.snr.filter((x) => x.maxLag > 0)) {
      const r = snrFromCoherency(c.traces.map(nan), { maxLag: c.maxLag });
      expect(Math.abs(r.snr - c.realised) / c.realised).toBeLessThan(0.3);
    }
  });
});

describe('footprint', () => {
  test.each(G.footprint.map((c) => [c.kind, c]))('%s: period, share and prominence along both axes', (_, c) => {
    const f = footprint(c.slice);
    for (const ax of ['alongCrossline', 'alongInline']) {
      const o = c.out[ax];
      if (o.period === null) expect(f[ax].period).toBeNaN(); else rel(f[ax].period, o.period, 1e-12);
      rel(f[ax].share, o.share, 1e-9);
      rel(f[ax].prominence, o.prominence, 1e-9);
    }
  });
});
