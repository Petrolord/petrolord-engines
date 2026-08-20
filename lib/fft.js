// Iterative radix-2 Cooley-Tukey FFT, float64, in-place. Extracted
// verbatim from engines/seismolord/synthetics.js at the second consumer
// (W2.2 trace attributes need the analytic signal); the synthetics
// goldens pin its behaviour bit-for-bit. Length must be a power of two —
// callers zero-pad and own that recipe (and their oracles mirror it).

/**
 * @param {Float64Array} re real part, length a power of two
 * @param {Float64Array} im imaginary part, same length
 * @param {boolean} invert inverse transform (scales by 1/n)
 */
export function fft(re, im, invert) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((invert ? 1 : -1) * 2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j];
        const ui = im[i + j];
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr;
        im[i + j + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (invert) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** Smallest power of two >= n (n >= 1). */
export function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
