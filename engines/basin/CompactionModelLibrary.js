
/** Own-property preset lookup. `TABLE[key]` walks the prototype chain, so
 *  'constructor', 'toString', 'valueOf', 'hasOwnProperty' and '__proto__'
 *  are "found" in every object literal and walk through a falsy guard. */
const ownPreset = (table, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);

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