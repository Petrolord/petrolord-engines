// Well control planning calculations (Drilling D3): well volumes and
// strokes, kill sheet (wait-and-weight and driller's method), kick
// tolerance and MAASP. Kill-sheet grade hydrostatics in the IWCF/IADC
// convention:
//
//   formation pressure  Pf  = ρ·g·TVD + SIDPP
//   kill mud density    KMW = ρ + SIDPP/(g·TVD)
//   initial circulating pressure  ICP = SCR + SIDPP
//   final circulating pressure    FCP = SCR·KMW/ρ
//   MAASP = (fracEMW − ρ)·g·TVD_shoe
//
// Kick tolerance (planning convention, single bubble, isothermal Boyle):
//   the influx column height that keeps shoe pressure at or below the
//   fracture pressure, evaluated for the shut-in influx at bottom AND for
//   the bubble circulated to just below the shoe at constant BHP; the
//   shoe-case volume is Boyle-converted back to an initial pit gain. The
//   reported tolerance is the smaller of the two.
//
// Assumptions (stated, deliberate for v1): surface BOP (no choke-line
// friction), single-bubble incompressible-mud hydrostatics, isothermal
// gas, vertical-column TVDs from the survey. This is a PLANNING tool in
// the kill-sheet tradition, not a transient kill simulator.
//
// Units STRICT SI: Pa, kg/m³, m, m², m³. UI converts to psi/ppg/bbl.
// Validation: independent oracle (oracle_wellcontrol.py) goldens incl. a
// self-asserting IWCF-style fixture + exact closed forms in
// __tests__/drilling.wellcontrol.test.js.

import { computeSurveyTable, attitudeAtMd, doglegRad } from './surveyMath.js';
import { buildFlowElements } from './hydraulics.js';

const G = 9.80665;
const DEG = Math.PI / 180;

// TVD at an arbitrary MD: exact partial minimum-curvature increment from the
// bracketing station (linear interpolation between stations is NOT exact on
// an arc and misses by decimetres at kill-sheet-relevant depths).
export function tvdAt(stations, mdRaw) {
  const table = computeSurveyTable(stations, { mdUnit: 'm' });
  // Clamp float-arithmetic overshoot at the path boundaries.
  const md = Math.min(Math.max(mdRaw, table[0].md), table[table.length - 1].md);
  if (md <= table[0].md) return table[0].tvd;
  for (let i = 1; i < table.length; i += 1) {
    if (md <= table[i].md + 1e-12) {
      const s1 = stations[i - 1];
      const att = attitudeAtMd(stations, md);
      const beta = doglegRad(s1.inc, s1.azi, att.inc, att.azi);
      const rf = beta < 1e-12 ? 1 : (2 / beta) * Math.tan(beta / 2);
      const dTvd = ((md - s1.md) / 2)
        * (Math.cos(s1.inc * DEG) + Math.cos(att.inc * DEG)) * rf;
      return table[i - 1].tvd + dTvd;
    }
  }
  return table[table.length - 1].tvd;
}

// ---- volumes ---------------------------------------------------------------

export function wellVolumes({ stations, string, geometry, pumpOutputM3PerStroke = null }) {
  const { pipeElements, annulusElements, bitMd } = buildFlowElements({ stations, string, geometry });
  let stringVolumeM3 = 0;
  const stringRows = [];
  for (const el of pipeElements) {
    const areaM2 = (Math.PI / 4) * el.dM * el.dM;
    const volM3 = areaM2 * el.lengthM;
    stringVolumeM3 += volM3;
    stringRows.push({ fromMd: el.fromMd, toMd: el.toMd, capM2: areaM2, volM3 });
  }
  let annulusVolumeM3 = 0;
  const annulusRows = [];
  for (const el of annulusElements) {
    if (!(el.dHoleM > 0)) continue;
    const areaM2 = (Math.PI / 4) * (el.dHoleM * el.dHoleM - el.dPipeOdM * el.dPipeOdM);
    if (!(areaM2 > 0)) continue;
    const volM3 = areaM2 * el.lengthM;
    annulusVolumeM3 += volM3;
    annulusRows.push({
      fromMd: el.fromMd, toMd: el.toMd, capM2: areaM2, volM3, cased: null,
    });
  }
  const out = {
    bitMd,
    stringVolumeM3,
    annulusVolumeM3,
    totalCirculatingM3: stringVolumeM3 + annulusVolumeM3,
    stringRows,
    annulusRows,
  };
  if (pumpOutputM3PerStroke > 0) {
    out.strokes = {
      surfaceToBit: stringVolumeM3 / pumpOutputM3PerStroke,
      bitToSurface: annulusVolumeM3 / pumpOutputM3PerStroke,
      fullCycle: (stringVolumeM3 + annulusVolumeM3) / pumpOutputM3PerStroke,
    };
  }
  return out;
}

// Annulus capacity per metre at a given MD (m²), from wellVolumes rows.
export function annulusCapAt(annulusRows, md) {
  for (const r of annulusRows) {
    if (md >= r.fromMd - 1e-9 && md <= r.toMd + 1e-9) return r.capM2;
  }
  return annulusRows.length ? annulusRows[annulusRows.length - 1].capM2 : null;
}

// ---- kill sheet ------------------------------------------------------------

export const INFLUX_GAS_MAX_KGM3 = 480;
export const INFLUX_LIQUID_MIN_KGM3 = 960;

export function killSheet({
  tvdBhM, tvdShoeM, mudDensityKgM3, sidppPa, sicpPa = null, pitGainM3 = 0,
  scrPressurePa, pumpOutputM3PerStroke, stringVolumeM3, annulusVolumeM3,
  annulusCapNearBitM2 = null, stepCount = 10,
}) {
  if (!(tvdBhM > 0) || !(tvdShoeM > 0) || tvdShoeM > tvdBhM) throw new Error('Need 0 < shoe TVD <= hole TVD.');
  if (!(mudDensityKgM3 > 0)) throw new Error('Mud density must be positive.');
  if (!(sidppPa >= 0)) throw new Error('SIDPP must be >= 0.');
  if (!(scrPressurePa >= 0)) throw new Error('Slow circulating rate pressure must be >= 0.');
  if (!(pumpOutputM3PerStroke > 0)) throw new Error('Pump output must be positive.');
  if (!(stringVolumeM3 > 0) || !(annulusVolumeM3 > 0)) throw new Error('Need positive string and annulus volumes.');

  const warnings = [];
  const formationPressurePa = mudDensityKgM3 * G * tvdBhM + sidppPa;
  const killMudDensityKgM3 = mudDensityKgM3 + sidppPa / (G * tvdBhM);
  const icpPa = scrPressurePa + sidppPa;
  const fcpPa = (scrPressurePa * killMudDensityKgM3) / mudDensityKgM3;

  const strokesToBit = stringVolumeM3 / pumpOutputM3PerStroke;
  const bottomsUpStrokes = annulusVolumeM3 / pumpOutputM3PerStroke;

  const schedule = [];
  for (let i = 0; i <= stepCount; i += 1) {
    const f = i / stepCount;
    schedule.push({
      strokes: f * strokesToBit,
      pressurePa: icpPa + f * (fcpPa - icpPa),
    });
  }

  // Influx characterization from the shut-in readings (informational).
  let influx = null;
  if (sicpPa != null && pitGainM3 > 0 && annulusCapNearBitM2 > 0) {
    if (sicpPa < sidppPa) warnings.push('SICP below SIDPP is unusual; check the shut-in readings.');
    const heightM = pitGainM3 / annulusCapNearBitM2;
    const gradientKgM3 = mudDensityKgM3 - (sicpPa - sidppPa) / (G * heightM);
    let kind = 'mixed';
    if (gradientKgM3 < INFLUX_GAS_MAX_KGM3) kind = 'gas';
    else if (gradientKgM3 > INFLUX_LIQUID_MIN_KGM3) kind = 'liquid';
    influx = { heightM, densityKgM3: gradientKgM3, kind };
  }

  return {
    engine: 'wellControl-1.0.0',
    formationPressurePa,
    killMudDensityKgM3,
    icpPa,
    fcpPa,
    strokesToBit,
    bottomsUpStrokes,
    totalStrokes: strokesToBit + bottomsUpStrokes,
    schedule,
    methods: {
      waitAndWeight: {
        description: 'One circulation with kill mud: ICP to FCP over surface-to-bit strokes, then FCP until the annulus is displaced.',
        circulations: 1,
        totalStrokes: strokesToBit + bottomsUpStrokes,
      },
      drillers: {
        description: 'Circulation 1 at constant ICP with original mud (full bottoms-up), then circulation 2 with kill mud: ICP to FCP over surface-to-bit strokes, then FCP.',
        circulations: 2,
        totalStrokes: (strokesToBit + bottomsUpStrokes) * 2,
      },
    },
    influx,
    warnings,
  };
}

// ---- kick tolerance --------------------------------------------------------

export function boyle({ p1Pa, v1M3, p2Pa }) {
  if (!(p1Pa > 0) || !(p2Pa > 0) || !(v1M3 >= 0)) throw new Error('Boyle needs positive pressures and non-negative volume.');
  return (p1Pa * v1M3) / p2Pa;
}

export function maaspPa({ tvdShoeM, mudDensityKgM3, fracEmwKgM3 }) {
  if (!(tvdShoeM > 0)) throw new Error('Shoe TVD must be positive.');
  if (!(fracEmwKgM3 > 0)) throw new Error('Fracture EMW must be positive.');
  return Math.max(0, (fracEmwKgM3 - mudDensityKgM3) * G * tvdShoeM);
}

export function kickTolerance({
  tvdBhM, tvdShoeM, mudDensityKgM3, fracEmwKgM3,
  kickIntensityKgM3 = null, formationPressurePa = null,
  influxDensityKgM3 = 240,
  annulusCapAtShoeM2, annulusCapAtBitM2,
}) {
  if (!(tvdBhM > 0) || !(tvdShoeM > 0) || tvdShoeM > tvdBhM) throw new Error('Need 0 < shoe TVD <= hole TVD.');
  if (!(annulusCapAtShoeM2 > 0) || !(annulusCapAtBitM2 > 0)) throw new Error('Annulus capacities must be positive.');
  if (!(influxDensityKgM3 >= 0) || influxDensityKgM3 >= mudDensityKgM3) {
    throw new Error('Influx density must sit below the mud density.');
  }
  let pf = formationPressurePa;
  if (pf == null) {
    if (kickIntensityKgM3 == null) throw new Error('Give kickIntensityKgM3 or formationPressurePa.');
    pf = (mudDensityKgM3 + kickIntensityKgM3) * G * tvdBhM;
  }
  const pFracShoe = fracEmwKgM3 * G * tvdShoeM;
  const maasp = maaspPa({ tvdShoeM, mudDensityKgM3, fracEmwKgM3 });

  // Shoe-pressure headroom with the influx column of height h (density ρi)
  // anywhere between shoe and bottom while BHP = Pf:
  //   P_shoe(h) = Pf − ρm·g·(TVDbh − TVDshoe) + (ρm − ρi)·g·h  <=  P_frac
  const headroomPa = pFracShoe - (pf - mudDensityKgM3 * G * (tvdBhM - tvdShoeM));
  const dRho = (mudDensityKgM3 - influxDensityKgM3) * G;
  const hMaxM = Math.max(0, headroomPa / dRho);

  // Case A: shut-in, influx standing at the bottom of the hole.
  const shutInM3 = hMaxM * annulusCapAtBitM2;

  // Case B: bubble circulated to just below the shoe at constant BHP;
  // volume at the shoe, Boyle-converted back to the initial pit gain.
  const hShoe = Math.min(hMaxM, Math.max(0, tvdBhM - tvdShoeM));
  const vAtShoeM3 = hShoe * annulusCapAtShoeM2;
  const pShoe = pf - mudDensityKgM3 * G * (tvdBhM - tvdShoeM)
    + (mudDensityKgM3 - influxDensityKgM3) * G * hShoe;
  const atShoeM3 = pShoe > 0 ? boyle({ p1Pa: pShoe, v1M3: vAtShoeM3, p2Pa: pf }) : 0;

  return {
    engine: 'wellControl-1.0.0',
    maaspPa: maasp,
    formationPressurePa: pf,
    headroomPa,
    cases: { shutInM3, atShoeM3 },
    kickToleranceM3: Math.max(0, Math.min(shutInM3, atShoeM3)),
    assumptions: 'Single bubble, isothermal Boyle expansion, surface BOP, vertical hydrostatics between shoe and TD.',
  };
}

export function kickToleranceSweep({ mudDensities = null, kickIntensities = null, base }) {
  const rows = [];
  if (mudDensities) {
    for (const rho of mudDensities) {
      try {
        const kt = kickTolerance({ ...base, mudDensityKgM3: rho });
        rows.push({ mudDensityKgM3: rho, kickToleranceM3: kt.kickToleranceM3, maaspPa: kt.maaspPa });
      } catch {
        rows.push({ mudDensityKgM3: rho, kickToleranceM3: null, maaspPa: null });
      }
    }
  } else if (kickIntensities) {
    for (const ki of kickIntensities) {
      try {
        const kt = kickTolerance({ ...base, kickIntensityKgM3: ki });
        rows.push({ kickIntensityKgM3: ki, kickToleranceM3: kt.kickToleranceM3 });
      } catch {
        rows.push({ kickIntensityKgM3: ki, kickToleranceM3: null });
      }
    }
  }
  return rows;
}
