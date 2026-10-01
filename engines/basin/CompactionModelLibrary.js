
/** Own-property preset lookup. `TABLE[key]` walks the prototype chain, so
 *  'constructor', 'toString', 'valueOf', 'hasOwnProperty' and '__proto__'
 *  are "found" in every object literal and walk through a falsy guard. */
const ownPreset = (table, key) => (typeof key === 'string' || typeof key === 'number') && Object.prototype.hasOwnProperty.call(table, key);

/**
 * Compaction Model Parameters (Sclater & Christie, 1980)
 * φ(z) = φ0 * exp(-c * z)
 */

export const LithologyCompaction = {
    sandstone: {
      phi0: 0.49,
      c: 0.00027, // per meter
      grainDensity: 2650 // kg/m3
    },
    shale: {
      phi0: 0.63,
      c: 0.00051,
      grainDensity: 2720
    },
    limestone: {
      phi0: 0.45, // Varied, simplistic here
      c: 0.00035, // approx
      grainDensity: 2710
    },
    salt: {
      phi0: 0.05, // Salt doesn't compact much like clastics, acts plastic
      c: 0.0001,
      grainDensity: 2160
    },
    coal: {
        phi0: 0.10,
        c: 0.0002,
        grainDensity: 1300
    },
    // Default fallback
    default: {
      phi0: 0.50,
      c: 0.0004,
      grainDensity: 2600
    }
  };
  
  export const getCompactionParams = (lithology) => {
    const key = lithology?.toLowerCase();
    return (ownPreset(LithologyCompaction, key) ? LithologyCompaction[key] : null) || LithologyCompaction.default;
  };

/**
 * U2-013 lithology mixing: the fractions of a mixed layer (percent or
 * fractions, any scale; unknown names ignored). Hantschel and Kauerauf
 * (2009, Fundamentals of Basin and Petroleum Systems Modeling, ch. 2 and
 * 3): Athy surface porosity, compaction coefficient and grain density mix
 * arithmetically by volume fraction.
 * @returns {Array<[string, number]>} [lithology, fraction] summing to 1, or [] for no usable mix
 */
export const mixFractions = (mix) => {
    const rows = Object.entries(mix || {})
        .filter(([k, w]) => ownPreset(LithologyCompaction, k) && k !== 'default' && Number(w) > 0)
        .map(([k, w]) => [k, Number(w)]);
    const tot = rows.reduce((a, [, w]) => a + w, 0);
    return tot > 0 ? rows.map(([k, w]) => [k, w / tot]) : [];
};

export const mixCompactionParams = (mix) => {
    const f = mixFractions(mix);
    if (!f.length) return LithologyCompaction.default;
    const out = { phi0: 0, c: 0, grainDensity: 0 };
    for (const [k, w] of f) {
        const p = LithologyCompaction[k];
        out.phi0 += w * p.phi0; out.c += w * p.c; out.grainDensity += w * p.grainDensity;
    }
    return out;
};
