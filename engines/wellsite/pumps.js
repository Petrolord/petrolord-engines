// Wellsite Studio WS0: mud pump displacement (spec section 14 inputs).
// SI internally: metres, cubic metres per stroke. Triplex single acting:
// 3 x pi/4 x D^2 x L x efficiency. Duplex double acting, rod on the back
// stroke: 2 x pi/4 x L x (2 D^2 minus d^2) x efficiency. Field formulas
// (0.000243 x D^2 x L for a triplex in bbl/stk with inches) are the same
// geometry with a rounded constant, and the goldens say by how much.

export const PUMP_TYPES = Object.freeze(['triplex', 'duplex']);
export const M_PER_IN = 0.0254;
export const M3_PER_BBL = 0.158987294928;

export function pumpDisplacement({ type = 'triplex', linerIdM, strokeLengthM, rodDiameterM = 0, efficiency = 1 }) {
  if (!PUMP_TYPES.includes(type)) throw new Error('Pump type must be triplex or duplex.');
  if (!(linerIdM > 0)) throw new Error('Liner inside diameter must be positive.');
  if (!(strokeLengthM > 0)) throw new Error('Stroke length must be positive.');
  if (!(efficiency > 0 && efficiency <= 1)) throw new Error('Pump efficiency must be between 0 and 1.');
  const area = (Math.PI / 4) * linerIdM * linerIdM;
  let theoretical;
  let cylinders;
  if (type === 'triplex') {
    cylinders = 3;
    theoretical = cylinders * area * strokeLengthM;
  } else {
    cylinders = 2;
    const rodArea = (Math.PI / 4) * rodDiameterM * rodDiameterM;
    theoretical = cylinders * strokeLengthM * (2 * area - rodArea);
  }
  return {
    type,
    cylinders,
    efficiency,
    theoreticalM3PerStroke: theoretical,
    m3PerStroke: theoretical * efficiency,
    bblPerStroke: (theoretical * efficiency) / M3_PER_BBL,
    perCylinderM3: theoretical / cylinders,
  };
}

/** Convenience for field entry in inches. */
export function displacementFromField({ type = 'triplex', linerIn, strokeIn, rodIn = 0, efficiency = 1 }) {
  return pumpDisplacement({
    type,
    linerIdM: linerIn * M_PER_IN,
    strokeLengthM: strokeIn * M_PER_IN,
    rodDiameterM: rodIn * M_PER_IN,
    efficiency,
  });
}

export function flowRate({ m3PerStroke, spm }) {
  const m3PerMin = m3PerStroke * spm;
  return { m3PerMin, lPerMin: m3PerMin * 1000, gpm: m3PerMin * 264.172052, bblPerMin: m3PerMin / M3_PER_BBL };
}

export function strokesForVolume(m3, m3PerStroke) {
  if (!(m3PerStroke > 0)) throw new Error('Pump displacement must be positive.');
  return m3 / m3PerStroke;
}
