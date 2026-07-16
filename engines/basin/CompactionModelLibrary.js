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
    return LithologyCompaction[key] || LithologyCompaction.default;
  };