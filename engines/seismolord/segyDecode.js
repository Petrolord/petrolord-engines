// Seismolord SEG-Y sample decoding — the trust-critical core, seeded in
// Phase 0 so the decode math is golden-validated before the Phase 1
// streaming indexer is built around it.
//
// Domain rules (docs/scope/Seismolord-PLAYBOOK.md): IBM float is format
// code 1, IEEE is 5; headers are big-endian; inline/xline byte positions
// are caller-supplied, never assumed; coordinate scalar lives at trace
// byte 71 (negative = divide). Bit-exactness against segyio is asserted
// by src/pages/apps/Seismolord/__tests__/goldens.test.js.

export const TEXT_HEADER_BYTES = 3200;
export const BIN_HEADER_BYTES = 400;
export const TRACE_HEADER_BYTES = 240;

/**
 * IBM System/360 32-bit float word -> number.
 *
 * value = (-1)^sign * (fraction / 2^24) * 16^(exponent - 64).
 * Every step is a power-of-two operation, so the double result is exact
 * and rounds correctly when stored into a Float32Array.
 *
 * @param {number} word big-endian uint32 bit pattern
 * @returns {number}
 */
export function ibm32ToNumber(word) {
  if (word === 0) return 0;
  const sign = word >>> 31 ? -1 : 1;
  const exponent = (word >>> 24) & 0x7f;
  const fraction = word & 0x00ffffff;
  return sign * (fraction / 0x1000000) * Math.pow(2, (exponent - 64) * 4);
}

/**
 * Decode one trace's samples to float32.
 *
 * @param {DataView} view DataView over (at least) the sample bytes
 * @param {number} byteOffset offset of the first sample within the view
 * @param {number} ns number of samples to decode
 * @param {number} formatCode SEG-Y binary-header format (1=IBM, 5=IEEE)
 * @param {Float32Array} [out] destination (first ns slots); allocated if omitted
 * @returns {Float32Array}
 */
export function decodeSamples(view, byteOffset, ns, formatCode, out = new Float32Array(ns)) {
  if (formatCode === 1) {
    for (let i = 0; i < ns; i++) {
      const v = ibm32ToNumber(view.getUint32(byteOffset + i * 4, false));
      // segyio (our oracle) flushes IBM values below the float32 normal
      // range to +0 instead of producing denormals; match it exactly so
      // "bit-identical to segyio" has one defined semantics.
      out[i] = Math.abs(v) < 2 ** -126 ? 0 : v;
    }
  } else if (formatCode === 5) {
    for (let i = 0; i < ns; i++) {
      out[i] = view.getFloat32(byteOffset + i * 4, false);
    }
  } else {
    throw new Error(`Unsupported SEG-Y sample format code: ${formatCode}`);
  }
  return out;
}

/**
 * Read the fields Seismolord needs from the 400-byte binary header.
 * @param {DataView} view DataView positioned at the binary header start
 */
export function readBinaryHeader(view) {
  return {
    dtUs: view.getInt16(16, false),        // bytes 3217-3218
    ns: view.getInt16(20, false),          // bytes 3221-3222
    formatCode: view.getInt16(24, false),  // bytes 3225-3226
  };
}

/**
 * Read an int32 trace-header word at a caller-supplied 1-based byte
 * position — inline/xline positions are configuration, never constants.
 *
 * @param {DataView} view DataView positioned at the trace-header start
 * @param {number} bytePos1Based SEG-Y trace-header byte position (1-240)
 */
export function readHeaderInt32(view, bytePos1Based) {
  return view.getInt32(bytePos1Based - 1, false);
}

/** @param {DataView} view @param {number} bytePos1Based */
export function readHeaderInt16(view, bytePos1Based) {
  return view.getInt16(bytePos1Based - 1, false);
}

/**
 * Apply the byte-71 coordinate scalar: negative means divide, positive
 * means multiply, 0/1 mean unscaled.
 *
 * @param {number} raw stored coordinate integer
 * @param {number} scalar SourceGroupScalar from trace byte 71
 */
export function applyCoordScalar(raw, scalar) {
  if (scalar < 0) return raw / -scalar;
  if (scalar > 1) return raw * scalar;
  return raw;
}
