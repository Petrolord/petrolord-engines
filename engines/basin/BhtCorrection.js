/**
 * Bottom-hole temperature corrections (Basin & Charge Modeling U2-006).
 *
 * A log-run BHT is cooler than the formation: circulating mud cooled the
 * borehole wall. Three published corrections:
 *
 *  - Horner (Dowdle and Cobb 1975; Horner 1951 by analogy with pressure
 *    build-up): with circulation time tc and times since circulation
 *    stopped ts_i, T is linear in ln((tc + ts) / ts); the formation
 *    temperature is the intercept at ln(...) = 0 (infinite shut-in).
 *    Needs two or more runs at one depth. Validated on the ZetaWare BHT
 *    utility's worked example (two runs: 115 at 8 h and 120 at 12 h after
 *    10 h of circulation give 134.80).
 *  - AAPG (Kehle et al. 1970, equation by Gregory et al. 1980):
 *    dT(F) = -8.819e-12 x^3 - 2.143e-8 x^2 + 4.375e-3 x - 1.018, x depth
 *    in ft. One BHT, no times.
 *  - Harrison et al. (1983), Oklahoma: dT(C) = -16.512 + 0.0183 x
 *    - 2.34e-6 x^2, x depth in m (SMU Geothermal Laboratory form).
 *
 * Temperatures in C, depths in m, times in hours; the published forms in
 * F and ft are converted here.
 */

const FT_PER_M = 1 / 0.3048;

/** Horner extrapolation. @param {Array<{shutInH:number, temp:number}>} runs @param {number} circulationH */
export function hornerCorrection(runs, circulationH) {
    const tc = Number(circulationH);
    const pts = (runs || [])
        .map((r) => ({ ts: Number(r.shutInH), t: Number(r.temp) }))
        .filter((r) => Number.isFinite(r.ts) && r.ts > 0 && Number.isFinite(r.t));
    if (!(tc > 0)) return { ok: false, reason: 'Horner needs the circulation time (hours, above 0).' };
    if (pts.length < 2) return { ok: false, reason: 'Horner needs two or more runs at one depth, each with its time since circulation stopped.' };
    if (new Set(pts.map((p) => p.ts)).size < 2) return { ok: false, reason: 'Horner needs runs at different times since circulation stopped.' };
    const xs = pts.map((p) => Math.log((tc + p.ts) / p.ts));
    const ys = pts.map((p) => p.t);
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxx = 0; let sxy = 0; let syy = 0;
    for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2; }
    const slope = sxy / sxx;
    const intercept = my - slope * mx;
    const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 1;
    const warnings = [];
    if (slope > 0) warnings.push('The temperature falls with shut-in time; the runs do not show a recovering borehole, check them.');
    if (n === 2) warnings.push('Two runs fit a line exactly; a third run checks the straight line.');
    return { ok: true, method: 'horner', temp: intercept, slope, r2, n, maxRun: Math.max(...ys), warnings };
}

/** AAPG (Kehle) correction for one BHT at a depth (m). */
export function aapgCorrection(bhtC, depthM) {
    const x = Number(depthM) * FT_PER_M;
    if (!Number.isFinite(x) || !Number.isFinite(Number(bhtC))) return { ok: false, reason: 'A depth and a temperature are needed.' };
    const dF = -8.819e-12 * x ** 3 - 2.143e-8 * x ** 2 + 4.375e-3 * x - 1.018;
    const dC = dF * 5 / 9;
    const warnings = [];
    if (x > 20000 || x < 1000) warnings.push('Outside the depths the AAPG data set covers (about 1,000 to 20,000 ft).');
    return { ok: true, method: 'aapg', temp: Number(bhtC) + Math.max(0, dC), deltaC: dC, warnings };
}

/** Harrison et al. (1983) correction for one BHT at a depth (m). */
export function harrisonCorrection(bhtC, depthM) {
    const x = Number(depthM);
    if (!Number.isFinite(x) || !Number.isFinite(Number(bhtC))) return { ok: false, reason: 'A depth and a temperature are needed.' };
    const dC = -16.512 + 0.0183 * x - 2.34e-6 * x * x;
    const warnings = [];
    if (dC < 0) warnings.push('Harrison gives a negative correction at this depth (shallower than about 1,000 m); no correction applied.');
    if (x > 3900) warnings.push('Deeper than the Harrison data (about 3,900 m), where its correction turns down.');
    return { ok: true, method: 'harrison', temp: Number(bhtC) + Math.max(0, dC), deltaC: dC, warnings };
}

/**
 * Correct a set of measured temperatures. Each point {depth, value, ...}
 * may carry runs (Horner) or be a single BHT. Points marked kind 'DST'
 * or 'static' are already formation temperatures and pass unchanged.
 * @param {Array} points
 * @param {'none'|'horner'|'aapg'|'harrison'} method
 * @returns {Array<{depth, raw, value, method, note}>}
 */
export function correctTemperatures(points, method, { circulationH = null } = {}) {
    return (points || []).map((p) => {
        const raw = Number(p.value);
        const base = { ...p, raw, value: raw, method: 'none', note: '' };
        if (method === 'none' || !method) return base;
        if (p.kind && /^(dst|static|equilibrium)$/i.test(p.kind)) return { ...base, note: `${p.kind} temperature, not corrected` };
        let r;
        if (method === 'horner') {
            r = hornerCorrection(p.runs, p.circulationH ?? circulationH);
            if (!r.ok) return { ...base, note: r.reason };
        } else if (method === 'aapg') r = aapgCorrection(raw, p.depth);
        else if (method === 'harrison') r = harrisonCorrection(raw, p.depth);
        else return base;
        if (!r.ok) return { ...base, note: r.reason };
        return { ...base, value: r.temp, method: r.method, note: r.warnings.join(' ') };
    });
}
