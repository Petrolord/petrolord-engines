// Prestack conditioning for QI, the remainder of the QI programme's Q5
// (QI round 3, 2026-10-15; SOW section 7). Every operation here is judged
// by what it does to the primaries' amplitudes, because AVO reads them:
//  - parabolic Radon demultiple (Hampson 1986): an NMO-corrected gather is
//    modelled as events with parabolic residual moveout t = tau + q (x/xr)^2;
//    multiples, under-corrected by the primary velocity, sit at large q. The
//    multiples are rebuilt from the large-q part of the model alone and
//    subtracted from the input, so the primaries are never passed through
//    the transform. Least squares per frequency with damping; the normal
//    matrix is Hermitian Toeplitz for evenly sampled q, so it is solved by
//    Levinson in O(nq^2). High resolution (Sacchi and Ulrych 1995) reweights
//    the damping by the model's energy along q, frequency independent,
//    iterated, solved by warm-started conjugate gradients. AVO terms (Ng and
//    Perz 2004) give each q an intercept and a gradient, so a primary whose
//    amplitude varies with offset stays at q = 0. The gather is cut into
//    overlapping time windows so the sparse weights follow the local events;
//  - f-x deconvolution (Canales 1984): at each frequency the spatial series
//    is predicted by a short complex filter, forward and backward, and the
//    predictable part kept (random noise is not predictable);
//  - survey shaping filter: one zero-phase operator per stack, from the
//    stack's mean amplitude spectrum to a target (another stack's, or flat in
//    a band), scaled so the stack's own band energy is kept. One operator for
//    every trace, so the relative amplitudes between traces stay exactly as
//    they were (qi/conditioning.js spectralBalance shapes each trace to an
//    absolute target, which equalises them; that is why it stays out of the
//    AVO path).
// Pure, float64. Nulls (non-finite or |v| >= 1e29) are treated as zero in
// the transforms and stay null in the outputs.

import { fft, nextPow2 } from '../../lib/fft.js';

const fin = Number.isFinite;
const live = (v) => fin(v) && Math.abs(v) < 1e29;

// ---------------------------------------------------------------------------
// Complex linear algebra (split re/im arrays)

/**
 * Solve a Toeplitz system T x = y, T[i][j] = t(i - j), by the Levinson
 * recursion (forward and backward vectors), complex. t is given for lags
 * -(n-1)..(n-1) as tRe[n - 1 + lag], tIm[n - 1 + lag].
 * @returns {{re: Float64Array, im: Float64Array}}
 */
export function toeplitzSolve(tRe, tIm, yRe, yIm) {
  const n = yRe.length; const o = n - 1;
  const t0r = tRe[o]; const t0i = tIm[o];
  const d0 = t0r * t0r + t0i * t0i;
  if (!(d0 > 0)) throw new Error('The Toeplitz diagonal is zero.');
  let fr = new Float64Array(n); let fi = new Float64Array(n);
  let br = new Float64Array(n); let bi = new Float64Array(n);
  const xr = new Float64Array(n); const xi = new Float64Array(n);
  // 1 / t0
  fr[0] = t0r / d0; fi[0] = -t0i / d0; br[0] = fr[0]; bi[0] = fi[0];
  xr[0] = yRe[0] * fr[0] - yIm[0] * fi[0]; xi[0] = yRe[0] * fi[0] + yIm[0] * fr[0];
  const nfr = new Float64Array(n); const nfi = new Float64Array(n);
  const nbr = new Float64Array(n); const nbi = new Float64Array(n);
  for (let m = 1; m < n; m++) {
    // ef = sum_i t(m - i) f_i ; eb = sum_i t(-(i + 1)) b_i ; ex = sum_i t(m - i) x_i
    let efr = 0; let efi = 0; let ebr = 0; let ebi = 0; let exr = 0; let exi = 0;
    for (let i = 0; i < m; i++) {
      const ar = tRe[o + m - i]; const ai = tIm[o + m - i];
      efr += ar * fr[i] - ai * fi[i]; efi += ar * fi[i] + ai * fr[i];
      exr += ar * xr[i] - ai * xi[i]; exi += ar * xi[i] + ai * xr[i];
      const cr = tRe[o - i - 1]; const ci = tIm[o - i - 1];
      ebr += cr * br[i] - ci * bi[i]; ebi += cr * bi[i] + ci * br[i];
    }
    // den = 1 - eb ef
    const pr = 1 - (ebr * efr - ebi * efi); const pi = -(ebr * efi + ebi * efr);
    const dd = pr * pr + pi * pi;
    if (!(dd > 0)) throw new Error('The Toeplitz system is singular.');
    const ir = pr / dd; const ii = -pi / dd; // 1/den
    // ef/den and eb/den
    const afr = efr * ir - efi * ii; const afi = efr * ii + efi * ir;
    const abr = ebr * ir - ebi * ii; const abi = ebr * ii + ebi * ir;
    for (let i = 0; i <= m; i++) {
      const fpr = i < m ? fr[i] : 0; const fpi = i < m ? fi[i] : 0; // [f; 0]
      const bpr = i > 0 ? br[i - 1] : 0; const bpi = i > 0 ? bi[i - 1] : 0; // [0; b]
      nfr[i] = (fpr * ir - fpi * ii) - (bpr * afr - bpi * afi);
      nfi[i] = (fpr * ii + fpi * ir) - (bpr * afi + bpi * afr);
      nbr[i] = (bpr * ir - bpi * ii) - (fpr * abr - fpi * abi);
      nbi[i] = (bpr * ii + bpi * ir) - (fpr * abi + fpi * abr);
    }
    fr = Float64Array.from(nfr); fi = Float64Array.from(nfi); br = Float64Array.from(nbr); bi = Float64Array.from(nbi);
    const gr = yRe[m] - exr; const gi = yIm[m] - exi;
    for (let i = 0; i <= m; i++) {
      xr[i] += gr * br[i] - gi * bi[i];
      xi[i] += gr * bi[i] + gi * br[i];
    }
  }
  return { re: xr, im: xi };
}

/**
 * Solve A x = y for a Hermitian positive definite A (n x n, row-major
 * re/im), by complex Cholesky. A is not modified.
 */
export function hermitianSolve(aRe, aIm, yRe, yIm, n) {
  const lr = new Float64Array(n * n); const li = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    let s = aRe[j * n + j];
    for (let k = 0; k < j; k++) s -= lr[j * n + k] ** 2 + li[j * n + k] ** 2;
    if (!(s > 0)) throw new Error('The matrix is not positive definite.');
    const d = Math.sqrt(s); lr[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      // L[i][j] = (A[i][j] - sum_k L[i][k] conj(L[j][k])) / d
      let sr = aRe[i * n + j]; let si = aIm[i * n + j];
      for (let k = 0; k < j; k++) {
        const ar = lr[i * n + k]; const ai = li[i * n + k]; const br = lr[j * n + k]; const bi = -li[j * n + k];
        sr -= ar * br - ai * bi; si -= ar * bi + ai * br;
      }
      lr[i * n + j] = sr / d; li[i * n + j] = si / d;
    }
  }
  const zr = new Float64Array(n); const zi = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sr = yRe[i]; let si = yIm[i];
    for (let k = 0; k < i; k++) { const ar = lr[i * n + k]; const ai = li[i * n + k]; sr -= ar * zr[k] - ai * zi[k]; si -= ar * zi[k] + ai * zr[k]; }
    zr[i] = sr / lr[i * n + i]; zi[i] = si / lr[i * n + i];
  }
  const xr = new Float64Array(n); const xi = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    // L^H[i][k] = conj(L[k][i])
    let sr = zr[i]; let si = zi[i];
    for (let k = i + 1; k < n; k++) { const ar = lr[k * n + i]; const ai = -li[k * n + i]; sr -= ar * xr[k] - ai * xi[k]; si -= ar * xi[k] + ai * xr[k]; }
    xr[i] = sr / lr[i * n + i]; xi[i] = si / lr[i * n + i];
  }
  return { re: xr, im: xi };
}

// ---------------------------------------------------------------------------
// Spectra of a set of traces

function spectraOf(traces, N) {
  return traces.map((t) => {
    const re = new Float64Array(N); const im = new Float64Array(N);
    if (t) for (let i = 0; i < t.length; i++) re[i] = live(t[i]) ? t[i] : 0;
    fft(re, im, false);
    return { re, im };
  });
}

function inverseReal(re, im, N, ns) {
  // fill the negative frequencies by conjugate symmetry, then invert
  for (let k = 1; k < N / 2; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
  im[0] = 0; im[N / 2] = 0;
  fft(re, im, true);
  return Float64Array.from({ length: ns }, (_, i) => re[i]);
}

// ---------------------------------------------------------------------------
// Parabolic Radon

/**
 * Solve (T + diag(dg)) x = y by Jacobi-preconditioned conjugate gradients,
 * T Hermitian block Toeplitz: P x P blocks of n, block (p, p') with the lags
 * of tRe[p + p'] (each lag array -(n-1)..(n-1) at index n - 1 + lag).
 * Starts from x0 when given (a warm start); stops at a relative residual
 * of 1e-5 or after maxIt iterations.
 */
export function blockToeplitzCg(tRe, tIm, P, n, dg, yRe, yIm, maxIt = 40, x0 = null) {
  const nu = P * n;
  const mul = (xr, xi, or, oi) => {
    for (let p = 0; p < P; p++) for (let i = 0; i < n; i++) {
      let sr = 0; let si = 0;
      for (let pp = 0; pp < P; pp++) {
        const Tr = tRe[p + pp]; const Ti = tIm[p + pp]; const base = n - 1 + i;
        for (let j = 0; j < n; j++) {
          const ar = Tr[base - j]; const ai = Ti[base - j]; const vr = xr[pp * n + j]; const vi = xi[pp * n + j];
          sr += ar * vr - ai * vi; si += ar * vi + ai * vr;
        }
      }
      const u = p * n + i;
      or[u] = sr + dg[u] * xr[u]; oi[u] = si + dg[u] * xi[u];
    }
  };
  const M = Float64Array.from({ length: nu }, (_, u) => 1 / (tRe[2 * Math.floor(u / n)][n - 1] + dg[u]));
  const xr = x0 ? Float64Array.from(x0.re) : new Float64Array(nu); const xi = x0 ? Float64Array.from(x0.im) : new Float64Array(nu);
  const rr = Float64Array.from(yRe); const ri = Float64Array.from(yIm);
  if (x0) { const ar = new Float64Array(nu); const ai = new Float64Array(nu); mul(xr, xi, ar, ai); for (let u = 0; u < nu; u++) { rr[u] -= ar[u]; ri[u] -= ai[u]; } }
  const zr = new Float64Array(nu); const zi = new Float64Array(nu);
  for (let u = 0; u < nu; u++) { zr[u] = M[u] * rr[u]; zi[u] = M[u] * ri[u]; }
  const pr = Float64Array.from(zr); const pi = Float64Array.from(zi);
  const qr = new Float64Array(nu); const qi = new Float64Array(nu);
  let rz = 0; let y2 = 0; let r0 = 0;
  for (let u = 0; u < nu; u++) { rz += rr[u] * zr[u] + ri[u] * zi[u]; y2 += yRe[u] ** 2 + yIm[u] ** 2; r0 += rr[u] ** 2 + ri[u] ** 2; }
  if (!(y2 > 0) || r0 < 1e-10 * y2) return { re: xr, im: xi };
  for (let it = 0; it < maxIt; it++) {
    mul(pr, pi, qr, qi);
    let pq = 0; for (let u = 0; u < nu; u++) pq += pr[u] * qr[u] + pi[u] * qi[u]; // Re(p^H A p), real for Hermitian A
    if (!(pq > 0)) break;
    const a = rz / pq;
    let r2 = 0;
    for (let u = 0; u < nu; u++) { xr[u] += a * pr[u]; xi[u] += a * pi[u]; rr[u] -= a * qr[u]; ri[u] -= a * qi[u]; r2 += rr[u] ** 2 + ri[u] ** 2; }
    if (r2 < 1e-10 * y2) break; // relative residual 1e-5
    let rz2 = 0;
    for (let u = 0; u < nu; u++) { zr[u] = M[u] * rr[u]; zi[u] = M[u] * ri[u]; rz2 += rr[u] * zr[u] + ri[u] * zi[u]; }
    const b = rz2 / rz; rz = rz2;
    for (let u = 0; u < nu; u++) { pr[u] = zr[u] + b * pr[u]; pi[u] = zi[u] + b * pi[u]; }
  }
  return { re: xr, im: xi };
}

/**
 * The q axis (ms of residual moveout at the reference offset) Radon samples.
 * The default spacing is 0.8 of Hampson's alias limit,
 * dq <= 1 / (fMax (xn_max^2 - xn_min^2)), so a parabola is never aliased.
 */
export function radonQAxis({ offsets, refOffset, qMinMs = -40, qMaxMs = 300, fMaxHz = 80, nq = null }) {
  const xr = refOffset || Math.max(...offsets.map((x) => Math.abs(x)));
  const xn2 = offsets.map((x) => (x / xr) ** 2);
  const span = Math.max(1e-6, Math.max(...xn2) - Math.min(...xn2));
  const dqLimit = 1000 / (fMaxHz * span); // ms
  const count = nq || Math.max(8, Math.ceil((qMaxMs - qMinMs) / (0.8 * dqLimit)) + 1);
  const dq = (qMaxMs - qMinMs) / (count - 1);
  return { q: Float64Array.from({ length: count }, (_, k) => qMinMs + k * dq), dq, refOffset: xr, dqAliasMs: dqLimit };
}

/**
 * Forward parabolic Radon of an NMO-corrected gather by damped least
 * squares in the frequency domain.
 * @param {{traces: ArrayLike<number>[], offsets: number[], dtMs: number,
 *   qMinMs?: number, qMaxMs?: number, nq?: number, fMaxHz?: number,
 *   refOffset?: number, damping?: number, highRes?: number, avo?: boolean}} p
 *   damping: as a fraction of the normal matrix's diagonal (the live trace
 *   count); highRes: sparse reweighting iterations (0 = least squares);
 *   avo: each q carries an intercept and a gradient term,
 *   (m0 + m1 xn^2) e^{-i w q xn^2} (AVO-compliant Radon, Ng and Perz 2004),
 *   so an event whose amplitude varies with offset stays at its own q
 *   instead of spreading along q
 * @returns {{q: Float64Array, model: {re: Float64Array, im: Float64Array}[], modelB: {re: Float64Array, im: Float64Array}[]|null, N: number, kMax: number, refOffset: number, ns: number, xn2: number[], live: boolean[]}}
 *   model[k] (and modelB[k] with avo) is the spectrum of the q[k] trace for frequency bins 0..kMax
 */
export function radonForward({ traces, offsets, dtMs, qMinMs = -40, qMaxMs = 300, nq = null, fMaxHz = null, refOffset = null, damping = 0.02, highRes = 0, avo = false, cgIterations = 15 }) {
  const ns = traces.find((t) => t)?.length || 0;
  if (!ns) throw new Error('The gather has no traces.');
  const nyq = 500 / dtMs;
  const fMax = Math.min(fMaxHz || 70, 0.8 * nyq);
  const isLive = traces.map((t) => !!t && Array.prototype.some.call(t, (v) => live(v) && v !== 0));
  const use = offsets.map((_, j) => j).filter((j) => isLive[j]);
  if (use.length < (avo ? 4 : 3)) throw new Error('Radon needs at least three live traces (four with AVO terms).');
  const ax = radonQAxis({ offsets: use.map((j) => offsets[j]), refOffset, qMinMs, qMaxMs, fMaxHz: fMax, nq });
  const { q, dq } = ax; const n = q.length;
  const xr = ax.refOffset;
  const xn2 = offsets.map((x) => (x / xr) ** 2);
  const N = nextPow2(ns) * 2; const df = 1000 / (N * dtMs);
  const kMax = Math.min(N / 2, Math.floor(fMax / df));
  const sp = spectraOf(use.map((j) => traces[j]), N);
  const nx = use.length;
  const P = avo ? 2 : 1; const nu = n * P;
  const model = Array.from({ length: n }, () => ({ re: new Float64Array(kMax + 1), im: new Float64Array(kMax + 1) }));
  const modelB = avo ? Array.from({ length: n }, () => ({ re: new Float64Array(kMax + 1), im: new Float64Array(kMax + 1) })) : null;
  // Toeplitz lags of each block: T_pp'(lag) = sum_a xn2^(p + p') e^{i w lag dq xn2}
  const tRe = Array.from({ length: 2 * P - 1 }, () => new Float64Array(2 * n - 1));
  const tIm = Array.from({ length: 2 * P - 1 }, () => new Float64Array(2 * n - 1));
  const yRe = new Float64Array(nu); const yIm = new Float64Array(nu);
  // diagonal of the normal matrix per unknown (for the damping scale)
  const diagScale = new Float64Array(nu);
  for (let p = 0; p < P; p++) { let s = 0; for (let a = 0; a < nx; a++) s += xn2[use[a]] ** (2 * p); for (let m = 0; m < n; m++) diagScale[p * n + m] = s; }
  const solveAll = (weights) => {
    for (let k = 1; k <= kMax; k++) {
      const w = (2 * Math.PI * k * df) / 1000; // rad per ms
      for (const t of tRe) t.fill(0); for (const t of tIm) t.fill(0);
      yRe.fill(0); yIm.fill(0);
      for (let a = 0; a < nx; a++) {
        const x2 = xn2[use[a]];
        const pw = [1, x2, x2 * x2];
        const p0 = -w * q[0] * x2; const st = -w * dq * x2;
        const sr = Math.cos(st); const si = Math.sin(st);
        let cr = Math.cos(p0); let ci = Math.sin(p0); // L[a][m] = e^{-i w q_m x2}
        const dr = sp[a].re[k]; const di = sp[a].im[k];
        let lr = 1; let li = 0; // e^{-i w m dq x2}
        for (let m = 0; m < n; m++) {
          const ur = cr * dr + ci * di; const ui = cr * di - ci * dr; // conj(L) d
          for (let p = 0; p < P; p++) { yRe[p * n + m] += pw[p] * ur; yIm[p * n + m] += pw[p] * ui; }
          for (let s = 0; s < 2 * P - 1; s++) {
            // lag +m: e^{+i w m dq x2} = conj(l); lag -m: l
            tRe[s][n - 1 + m] += pw[s] * lr; tIm[s][n - 1 + m] -= pw[s] * li;
            if (m > 0) { tRe[s][n - 1 - m] += pw[s] * lr; tIm[s][n - 1 - m] += pw[s] * li; }
          }
          const ncr = cr * sr - ci * si; ci = cr * si + ci * sr; cr = ncr;
          const nlr = lr * sr - li * si; li = lr * si + li * sr; lr = nlr;
        }
      }
      let sol;
      if (!weights && !avo) {
        tRe[0][n - 1] += damping * diagScale[0];
        sol = toeplitzSolve(tRe[0], tIm[0], yRe, yIm);
      } else {
        const dg = Float64Array.from({ length: nu }, (_, u) => damping * diagScale[u] * (weights ? weights[u % n] : 1));
        const x0 = weights ? { re: Float64Array.from({ length: nu }, (_, u) => (u < n ? model[u].re[k] : modelB[u - n].re[k])), im: Float64Array.from({ length: nu }, (_, u) => (u < n ? model[u].im[k] : modelB[u - n].im[k])) } : null;
        sol = blockToeplitzCg(tRe, tIm, P, n, dg, yRe, yIm, cgIterations, x0);
      }
      for (let m = 0; m < n; m++) {
        model[m].re[k] = sol.re[m]; model[m].im[k] = sol.im[m];
        if (avo) { modelB[m].re[k] = sol.re[n + m]; modelB[m].im[k] = sol.im[n + m]; }
      }
    }
  };
  solveAll(null);
  for (let it = 0; it < highRes; it++) {
    // energy of the model along q over the band (both terms, each on its trace scale)
    const e = Float64Array.from(model, (m, i) => {
      let s = 0;
      for (let k = 1; k <= kMax; k++) {
        s += m.re[k] ** 2 + m.im[k] ** 2;
        if (avo) s += (modelB[i].re[k] ** 2 + modelB[i].im[k] ** 2) * (diagScale[n] / diagScale[0]);
      }
      return s;
    });
    const emax = e.reduce((a, v) => Math.max(a, v), 0) || 1;
    // damping weight 1 where the model is strongest, larger where it is weak
    const weights = Float64Array.from(e, (v) => 1 / (v / emax + 1e-3));
    const wmin = weights.reduce((a, v) => Math.min(a, v), Infinity);
    for (let m = 0; m < n; m++) weights[m] /= wmin;
    solveAll(weights);
  }
  return { q, model, modelB, N, kMax, refOffset: xr, ns, xn2, live: isLive, dtMs };
}

/**
 * Traces at the given offsets from the part of a Radon model with q inside
 * [qFrom, qTo] (ms at the reference offset).
 */
export function radonInverse(rad, { qFrom = -Infinity, qTo = Infinity, xn2 = rad.xn2 } = {}) {
  const { q, model, modelB, N, kMax, ns, dtMs } = rad;
  const df = 1000 / (N * dtMs);
  const pick = Array.from(q).map((v, m) => m).filter((m) => q[m] >= qFrom && q[m] <= qTo);
  return xn2.map((x2) => {
    const re = new Float64Array(N); const im = new Float64Array(N);
    for (let k = 1; k <= kMax; k++) {
      const w = (2 * Math.PI * k * df) / 1000;
      let sr = 0; let si = 0;
      for (const m of pick) {
        const ph = -w * q[m] * x2; const c = Math.cos(ph); const s = Math.sin(ph);
        let mr = model[m].re[k]; let mi = model[m].im[k];
        if (modelB) { mr += x2 * modelB[m].re[k]; mi += x2 * modelB[m].im[k]; }
        sr += mr * c - mi * s; si += mr * s + mi * c;
      }
      re[k] = sr; im[k] = si;
    }
    if (kMax === N / 2) { re[N / 2] = 0; im[N / 2] = 0; }
    return inverseReal(re, im, N, ns);
  });
}

/**
 * Time windows covering ns samples: raised-cosine windows of windowMs,
 * stepped by step x the half length (1: 50 percent overlap, 0.5: 75
 * percent), normalised so they sum to one at every sample (a partition of
 * unity), so windowed pieces add back to the input exactly.
 * @returns {{i0: number, i1: number, w: Float64Array}[]}
 */
export function timeWindows(ns, dtMs, windowMs, step = 1) {
  const L = Math.round(windowMs / dtMs);
  if (!(L >= 8) || L >= ns) return [{ i0: 0, i1: ns - 1, w: new Float64Array(ns).fill(1) }];
  const h = Math.floor(L / 2); const st = Math.max(1, Math.round(h * Math.min(1, Math.max(0.25, step))));
  const out = []; const sum = new Float64Array(ns);
  for (let c = 0; ; c += st) {
    const cc = Math.min(c, ns - 1);
    const i0 = Math.max(0, cc - h); const i1 = Math.min(ns - 1, cc + h);
    const w = Float64Array.from({ length: i1 - i0 + 1 }, (_, k) => 0.5 * (1 + Math.cos((Math.PI * (i0 + k - cc)) / (h + 1))));
    w.forEach((v, k) => { sum[i0 + k] += v; });
    out.push({ i0, i1, w });
    if (cc >= ns - 1) break;
  }
  for (const win of out) win.w.forEach((v, k) => { win.w[k] = v / sum[win.i0 + k]; });
  return out;
}

/**
 * Radon demultiple of one NMO-corrected gather: the multiples are the model
 * at q >= cutMs (residual moveout at the reference offset), rebuilt and
 * subtracted from the input. AVO terms, three sparse iterations and 300 ms
 * windows are the defaults. With windowMs, the gather is cut into overlapping time windows
 * (raised-cosine, summing to one) and each is transformed on its own, so the
 * sparse weights along q follow the events in that window: a frequency-domain
 * Radon has no time resolution, and one set of weights for the whole trace
 * lets a primary leak into the q where the multiples are strong elsewhere.
 * @returns {{traces: Float64Array[], multiples: Float64Array[], q: Float64Array, removedFraction: number, windows: number}}
 *   traces: the demultipled gather (null traces stay null, null samples stay null);
 *   removedFraction: the share of the input energy taken away
 */
export function radonDemultiple({ traces, offsets, dtMs, cutMs = 30, qMinMs = -60, qMaxMs = 300, nq = null, fMaxHz = null, damping = 0.02, highRes = 3, avo = true, refOffset = null, windowMs = 300, windowStep = 0.5, cgIterations = 15 }) {
  if (!(qMaxMs > cutMs && cutMs > qMinMs)) throw new Error('The cut must lie inside the q range.');
  const ns = traces.find((t) => t)?.length || 0;
  const wins = timeWindows(ns, dtMs, windowMs, windowStep);
  const xr = refOffset || Math.max(...offsets.filter((x, j) => traces[j]).map((x) => Math.abs(x)));
  const mult = traces.map(() => new Float64Array(ns));
  let qAxis = null; let isLive = null;
  for (const { i0, i1, w } of wins) {
    const piece = traces.map((t) => (t ? Float64Array.from({ length: i1 - i0 + 1 }, (_, i) => (live(t[i0 + i]) ? w[i] * t[i0 + i] : 0)) : null));
    const anyLive = piece.filter((t) => t && t.some((v) => v !== 0)).length;
    if (anyLive < (avo ? 4 : 3)) continue;
    const rad = radonForward({ traces: piece, offsets, dtMs, qMinMs, qMaxMs, nq, fMaxHz, refOffset: xr, damping, highRes, avo, cgIterations });
    qAxis = qAxis || rad.q; isLive = isLive || traces.map((t) => !!t && Array.prototype.some.call(t, (v) => live(v) && v !== 0));
    const m = radonInverse(rad, { qFrom: cutMs });
    for (let j = 0; j < traces.length; j++) if (rad.live[j]) for (let i = i0; i <= i1; i++) mult[j][i] += m[j][i - i0];
  }
  if (!qAxis) throw new Error('Radon needs at least three live traces (four with AVO terms).');
  let ein = 0; let eout = 0;
  const out = traces.map((t, j) => {
    if (!t || !isLive[j]) return t ? Float64Array.from(t) : null;
    return Float64Array.from(t, (v, i) => {
      if (!live(v)) return v;
      const r = v - mult[j][i];
      ein += v * v; eout += r * r;
      return r;
    });
  });
  return { traces: out, multiples: mult.map((m, j) => (isLive[j] ? m : null)), q: qAxis, removedFraction: ein > 0 ? 1 - eout / ein : 0, windows: wins.length };
}

// ---------------------------------------------------------------------------
// f-x deconvolution

/** Least-squares complex prediction filter of length L for a series (forward when dir = 1, backward when -1). */
function predictionFilter(sr, si, L, damping, dir) {
  const n = sr.length;
  const aRe = new Float64Array(L * L); const aIm = new Float64Array(L * L);
  const yRe = new Float64Array(L); const yIm = new Float64Array(L);
  // rows j: target s_j, regressors s_{j - dir k}, k = 1..L
  for (let j = 0; j < n; j++) {
    const lo = j - dir * L; if (lo < 0 || lo >= n) continue;
    for (let a = 0; a < L; a++) {
      const ia = j - dir * (a + 1);
      const xr = sr[ia]; const xi = si[ia];
      // y_a += conj(x_a) s_j
      yRe[a] += xr * sr[j] + xi * si[j]; yIm[a] += xr * si[j] - xi * sr[j];
      for (let b = 0; b < L; b++) {
        const ib = j - dir * (b + 1);
        // A[a][b] += conj(x_a) x_b
        aRe[a * L + b] += xr * sr[ib] + xi * si[ib]; aIm[a * L + b] += xr * si[ib] - xi * sr[ib];
      }
    }
  }
  let tr = 0; for (let a = 0; a < L; a++) tr += aRe[a * L + a];
  if (!(tr > 0)) return null;
  for (let a = 0; a < L; a++) aRe[a * L + a] += damping * tr / L;
  return hermitianSolve(aRe, aIm, yRe, yIm, L);
}

// one time window of fxDecon
function fxDeconPiece({ traces, dtMs, filterLength = 3, damping = 0.01, fLoHz = 3, fHiHz = null, windowTraces = 0 }) {
  const ns = traces.find((t) => t)?.length || 0;
  if (!ns) throw new Error('No traces.');
  const isLive = traces.map((t) => !!t && Array.prototype.some.call(t, (v) => live(v) && v !== 0));
  const idx = traces.map((_, j) => j).filter((j) => isLive[j]);
  const L = Math.max(1, Math.round(filterLength));
  const out = traces.map((t) => (t ? Float64Array.from(t) : null));
  if (idx.length < 2 * L + 1) return { traces: out, removedFraction: 0 };
  const N = nextPow2(ns) * 2; const df = 1000 / (N * dtMs); const nyq = 500 / dtMs;
  const kLo = Math.max(1, Math.ceil(fLoHz / df)); const kHi = Math.min(N / 2 - 1, Math.floor(Math.min(fHiHz || 0.8 * nyq, nyq) / df));
  const W = windowTraces && windowTraces >= 2 * L + 1 && windowTraces < idx.length ? Math.round(windowTraces) : idx.length;
  const step = W === idx.length ? W : Math.max(1, Math.floor(W / 2));
  const starts = [];
  for (let s = 0; ; s += step) { const st = Math.min(s, idx.length - W); starts.push(st); if (st + W >= idx.length) break; }
  const sp = spectraOf(idx.map((j) => traces[j]), N);
  const accRe = idx.map(() => new Float64Array(N)); const accIm = idx.map(() => new Float64Array(N)); const wsum = new Float64Array(idx.length);
  for (const st of starts) {
    const tw = Float64Array.from({ length: W }, (_, a) => (starts.length === 1 ? 1 : 1 - Math.abs((a + 0.5) - W / 2) / (W / 2) + 1e-3));
    for (let a = 0; a < W; a++) wsum[st + a] += tw[a];
    for (let k = 0; k <= N / 2; k++) {
      const sr = new Float64Array(W); const si = new Float64Array(W);
      for (let a = 0; a < W; a++) { sr[a] = sp[st + a].re[k]; si[a] = sp[st + a].im[k]; }
      let pr = sr; let pi = si;
      if (k >= kLo && k <= kHi) {
        const ff = predictionFilter(sr, si, L, damping, 1);
        const fb = predictionFilter(sr, si, L, damping, -1);
        if (ff && fb) {
          pr = new Float64Array(W); pi = new Float64Array(W);
          for (let a = 0; a < W; a++) {
            let n = 0; let vr = 0; let vi = 0;
            for (const [f, dir] of [[ff, 1], [fb, -1]]) {
              if (a - dir * L < 0 || a - dir * L >= W) continue;
              let r = 0; let i = 0;
              for (let b = 0; b < L; b++) { const ib = a - dir * (b + 1); r += f.re[b] * sr[ib] - f.im[b] * si[ib]; i += f.re[b] * si[ib] + f.im[b] * sr[ib]; }
              vr += r; vi += i; n += 1;
            }
            pr[a] = n ? vr / n : sr[a]; pi[a] = n ? vi / n : si[a];
          }
        }
      }
      for (let a = 0; a < W; a++) { accRe[st + a][k] += tw[a] * pr[a]; accIm[st + a][k] += tw[a] * pi[a]; }
    }
  }
  let ein = 0; let eout = 0;
  idx.forEach((j, a) => {
    const re = Float64Array.from(accRe[a], (v) => v / wsum[a]); const im = Float64Array.from(accIm[a], (v) => v / wsum[a]);
    const r = inverseReal(re, im, N, ns);
    const t = traces[j];
    out[j] = Float64Array.from(t, (v, i) => { if (!live(v)) return v; ein += v * v; eout += r[i] * r[i]; return r[i]; });
  });
  return { traces: out, removedFraction: ein > 0 ? 1 - eout / ein : 0 };
}

/**
 * f-x deconvolution of an ordered set of traces (one gather across offset,
 * or a line of traces): at each frequency in [fLoHz, fHiHz] the spatial
 * series is predicted forward and backward by a filter of filterLength
 * traces and the mean prediction kept; outside the band the input passes.
 * The traces are cut into time windows of timeWindowMs (raised-cosine,
 * summing to one; 0 for one window), so each frequency slice holds few
 * events; spatial windows of windowTraces (50 percent overlap, triangular
 * blend) when the set is longer.
 * The prediction filter shrinks under noise, so a noisy event comes out a
 * little weaker: measured on the gates' synthetic gather, 2 to 7 percent of
 * the intercept at S/N 6 to 0 dB, under 1 percent on noise-free data.
 * @returns {{traces: Float64Array[], removedFraction: number}}
 */
export function fxDecon({ traces, dtMs, filterLength = 3, damping = 0.01, fLoHz = 3, fHiHz = null, windowTraces = 0, timeWindowMs = 200 }) {
  const ns = traces.find((t) => t)?.length || 0;
  if (!ns) throw new Error('No traces.');
  const wins = timeWindows(ns, dtMs, timeWindowMs || 0);
  const acc = traces.map((t) => (t ? new Float64Array(ns) : null));
  for (const { i0, i1, w } of wins) {
    const piece = traces.map((t) => (t ? Float64Array.from({ length: i1 - i0 + 1 }, (_, i) => (live(t[i0 + i]) ? w[i] * t[i0 + i] : 0)) : null));
    const r = fxDeconPiece({ traces: piece, dtMs, filterLength, damping, fLoHz, fHiHz, windowTraces });
    r.traces.forEach((t, j) => { if (t) for (let i = i0; i <= i1; i++) acc[j][i] += t[i - i0]; });
  }
  let ein = 0; let eout = 0;
  const out = traces.map((t, j) => (t ? Float64Array.from(t, (v, i) => { if (!live(v)) return v; ein += v * v; eout += acc[j][i] ** 2; return acc[j][i]; }) : null));
  return { traces: out, removedFraction: ein > 0 ? 1 - eout / ein : 0 };
}

// ---------------------------------------------------------------------------
// Survey shaping filter (spectral balancing that keeps relative amplitudes)

/** The mean amplitude spectrum of a set of traces (bins 0..N/2) and its bin width. */
export function meanAmplitudeSpectrum(traces, dtMs, N = null) {
  const ns = traces.find((t) => t)?.length || 0;
  const n2 = N || nextPow2(ns) * 2;
  const amp = new Float64Array(n2 / 2 + 1); let count = 0;
  for (const t of traces) {
    if (!t) continue;
    const { re, im } = spectraOf([t], n2)[0];
    for (let k = 0; k <= n2 / 2; k++) amp[k] += Math.hypot(re[k], im[k]);
    count += 1;
  }
  if (count) for (let k = 0; k < amp.length; k++) amp[k] /= count;
  return { amp, df: 1000 / (n2 * dtMs), N: n2, traces: count };
}

const smoothSpec = (a, h) => Float64Array.from(a, (_, k) => { let s = 0; let c = 0; for (let j = Math.max(0, k - h); j <= Math.min(a.length - 1, k + h); j++) { s += a[j]; c += 1; } return s / c; });

/**
 * One zero-phase shaping operator from a source mean spectrum to a target:
 * gain(f) = w(f) target(f) / source(f), smoothed, limited to maxGainDb above
 * the band's median gain, cosine tapers outside [fLo, fHi], and scaled so
 * the source's energy inside the band is kept.
 * @param {{amp: Float64Array, df: number}} source
 * @param {Float64Array|null} targetAmp the target spectrum on the same bins, or null for flat
 * @returns {{gain: Float64Array, df: number, N: number}}
 */
export function shapingOperator(source, targetAmp = null, { fLo = 8, fHi = 60, taperHz = 5, smoothHz = 4, maxGainDb = 20 } = {}) {
  const { amp, df } = source; const nb = amp.length;
  const h = Math.max(1, Math.round(smoothHz / df));
  const s = smoothSpec(amp, h);
  const t = targetAmp ? smoothSpec(targetAmp, h) : new Float64Array(nb).fill(1);
  const smax = s.reduce((a, v) => Math.max(a, v), 0);
  const w = Float64Array.from({ length: nb }, (_, k) => {
    const f = k * df;
    if (f < fLo) return f <= fLo - taperHz ? 0 : 0.5 * (1 + Math.cos((Math.PI * (fLo - f)) / taperHz));
    if (f > fHi) return f >= fHi + taperHz ? 0 : 0.5 * (1 + Math.cos((Math.PI * (f - fHi)) / taperHz));
    return 1;
  });
  const g = Float64Array.from({ length: nb }, (_, k) => (w[k] > 0 && s[k] > 1e-6 * smax ? (w[k] * t[k]) / s[k] : 0));
  const inBand = Array.from(g).filter((v, k) => k * df >= fLo && k * df <= fHi && v > 0).sort((a, b) => a - b);
  const med = inBand.length ? inBand[Math.floor(inBand.length / 2)] : 0;
  const cap = med * 10 ** (maxGainDb / 20);
  for (let k = 0; k < nb; k++) if (g[k] > cap) g[k] = cap;
  // keep the band energy: sum (g s)^2 = sum s^2 over the band
  let e0 = 0; let e1 = 0;
  for (let k = 0; k < nb; k++) { const f = k * df; if (f >= fLo && f <= fHi) { e0 += s[k] ** 2; e1 += (g[k] * s[k]) ** 2; } }
  const sc = e1 > 0 ? Math.sqrt(e0 / e1) : 0;
  for (let k = 0; k < nb; k++) g[k] *= sc;
  return { gain: g, df, N: 2 * (nb - 1) };
}

/** Apply a zero-phase gain (from shapingOperator) to one trace; nulls stay null. */
export function applyShaping(trace, op) {
  const { gain, N } = op; const ns = trace.length;
  const { re, im } = spectraOf([trace], N)[0];
  for (let k = 0; k <= N / 2; k++) { re[k] *= gain[k]; im[k] *= gain[k]; }
  const r = inverseReal(re, im, N, ns);
  return Float64Array.from(trace, (v, i) => (live(v) ? r[i] : v));
}
