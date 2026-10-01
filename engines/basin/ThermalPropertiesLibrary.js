
/** Own-property preset lookup. `TABLE[key]` walks the prototype chain, so
 *  'constructor', 'toString', 'valueOf', 'hasOwnProperty' and '__proto__'
 *  are "found" in every object literal and walk through a falsy guard. */
const ownPreset = (table, key) => (typeof key === 'string' || typeof key === 'number') && Object.prototype.hasOwnProperty.call(table, key);

/**
 * Thermal Properties Library
 * Values are approximate averages for standard lithologies
 */

export const ThermalProperties = {
    sandstone: {
      conductivity: 3.5, // W/(m*K) - Matrix
      radiogenic: 1.2e-6, // W/m3
      heatCapacity: 900 // J/(kg*K)
    },
    shale: {
      conductivity: 1.8,
      radiogenic: 1.8e-6,
      heatCapacity: 1100
    },
    limestone: {
      conductivity: 2.8,
      radiogenic: 0.8e-6,
      heatCapacity: 950
    },
    salt: {
      conductivity: 5.5,
      radiogenic: 0.1e-6,
      heatCapacity: 850
    },
    coal: {
        conductivity: 0.3,
        radiogenic: 0.5e-6,
        heatCapacity: 1300
    },
    water: {
      conductivity: 0.6,
      radiogenic: 0,
      heatCapacity: 4186,
      density: 1030 // Formation water
    },
    default: {
      conductivity: 2.5,
      radiogenic: 1.0e-6,
      heatCapacity: 1000
    }
  };
  
  export const getThermalProps = (lithology) => {
    const key = lithology?.toLowerCase();
    return (ownPreset(ThermalProperties, key) ? ThermalProperties[key] : null) || ThermalProperties.default;
  };

/**
 * U2-013 lithology mixing (Hantschel and Kauerauf 2009): matrix thermal
 * conductivity mixes as the GEOMETRIC mean weighted by volume fraction
 * (the same law the engine uses for rock and pore water); radiogenic heat
 * and heat capacity mix arithmetically.
 */
export const mixThermalProps = (mix) => {
    const rows = Object.entries(mix || {})
        .filter(([k, w]) => ownPreset(ThermalProperties, k) && k !== 'default' && k !== 'water' && Number(w) > 0)
        .map(([k, w]) => [k, Number(w)]);
    const tot = rows.reduce((a, [, w]) => a + w, 0);
    if (!(tot > 0)) return ThermalProperties.default;
    let lnK = 0; let rad = 0; let cp = 0;
    for (const [k, w0] of rows) {
        const w = w0 / tot; const p = ThermalProperties[k];
        lnK += w * Math.log(p.conductivity); rad += w * p.radiogenic; cp += w * p.heatCapacity;
    }
    return { conductivity: Math.exp(lnK), radiogenic: rad, heatCapacity: cp };
};
