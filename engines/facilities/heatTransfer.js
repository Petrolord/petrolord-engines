/**
 * Heat exchanger thermal design (Facilities F4).
 *
 * Rating and sizing at the level a facilities engineer actually works
 * before HTRI: duty and outlet temperatures from the energy balance,
 * LMTD with the correction factor COMPUTED from the published Bowman
 * closed form rather than read off a chart or typed, effectiveness-NTU
 * in both directions for the standard arrangements, the overall
 * coefficient built from its named resistances (film, wall, fouling,
 * with the tube-side film from Dittus-Boelter/Sieder-Tate), TEMA-style
 * tube count from a bundle-geometry fit, and air-cooler sizing with
 * the ambient derate that actually decides summer capacity.
 *
 * What this is NOT: a rigorous stream-analysis rating. Shell-side film
 * coefficients here are the Kern-method screening estimate, and the
 * studio says so. Bell-Delaware and beyond are HTRI's job.
 *
 * Units: field throughout (Btu/hr, F, lb/hr, ft2, Btu/hr.ft2.F).
 */

/* ------------------------------------------------------------------ *
 * Energy balance
 * ------------------------------------------------------------------ */

/** Capacity rate C = m cp, Btu/hr.F. */
export const capacityRate = ({ mLbHr, cpBtuLbF }) => {
  if (!(mLbHr > 0) || !(cpBtuLbF > 0)) return NaN;
  return mLbHr * cpBtuLbF;
};

/**
 * Close the energy balance from whatever three of the four terminal
 * temperatures are known, or from a stated duty. Refuses a crossed
 * exchanger rather than returning a negative LMTD downstream.
 */
export const energyBalance = ({
  cHot, cCold, thIn, thOut, tcIn, tcOut, qBtuHr,
}) => {
  if (!(cHot > 0) || !(cCold > 0)) return { error: 'both capacity rates must be positive' };
  if (!(thIn > tcIn)) return { error: 'the hot inlet must be hotter than the cold inlet' };
  let q = qBtuHr;
  if (!(q > 0)) {
    if (Number.isFinite(thOut)) q = cHot * (thIn - thOut);
    else if (Number.isFinite(tcOut)) q = cCold * (tcOut - tcIn);
    else return { error: 'give a duty or one outlet temperature' };
  }
  const hOut = thIn - q / cHot;
  const cOut = tcIn + q / cCold;
  if (hOut < tcIn || cOut > thIn) {
    return { error: 'this duty crosses the streams: the hot outlet falls below the cold inlet (or the reverse). No exchanger of any size does that.' };
  }
  return { qBtuHr: q, thOut: hOut, tcOut: cOut };
};

/* ------------------------------------------------------------------ *
 * LMTD and the correction factor
 * ------------------------------------------------------------------ */

export const lmtd = ({ thIn, thOut, tcIn, tcOut, arrangement = 'counter' }) => {
  const dt1 = arrangement === 'parallel' ? thIn - tcIn : thIn - tcOut;
  const dt2 = arrangement === 'parallel' ? thOut - tcOut : thOut - tcIn;
  if (!(dt1 > 0) || !(dt2 > 0)) {
    return { error: 'temperature cross: one end of the exchanger has no driving force' };
  }
  if (Math.abs(dt1 - dt2) < 1e-9) return { lmtdF: dt1, dt1, dt2 };
  return { lmtdF: (dt1 - dt2) / Math.log(dt1 / dt2), dt1, dt2 };
};

/** P and R, the dimensionless groups the F correction is written in. */
export const lmtdGroups = ({ thIn, thOut, tcIn, tcOut }) => {
  const span = thIn - tcIn;
  if (!(span > 0)) return { error: 'no temperature span between the inlets' };
  const p = (tcOut - tcIn) / span;
  const r = Math.abs(tcOut - tcIn) < 1e-12 ? Infinity : (thIn - thOut) / (tcOut - tcIn);
  return { p, r };
};

/**
 * Bowman's closed form for the LMTD correction factor of a 1 shell
 * pass / 2 tube pass exchanger (and, by the standard substitution, of
 * N shell passes). This is an EQUATION in the literature, not a chart,
 * so it is computed rather than typed -- the predecessor Suite app
 * made the user type an Ft, which is exactly where a design goes
 * quietly wrong.
 *
 * F below about 0.8 means the configuration is fighting the duty: the
 * curve is steep there and small errors in the terminal temperatures
 * swing the area badly, which is why the standards say to add shells
 * instead. The result carries that warning.
 */
export const lmtdCorrectionF = ({ p, r, shellPasses = 1 }) => {
  if (!(p >= 0) || p >= 1 || !(r > 0)) {
    return { error: 'F needs 0 <= P < 1 and R > 0' };
  }
  // N shell passes: convert P to the equivalent single-shell P1.
  let p1 = p;
  const n = Math.max(1, Math.round(shellPasses));
  if (n > 1) {
    if (Math.abs(r - 1) < 1e-9) {
      p1 = p / (n - p * (n - 1));
    } else {
      const s = ((1 - p * r) / (1 - p)) ** (1 / n);
      p1 = (s - 1) / (s - r);
    }
  }
  if (!(p1 >= 0) || p1 >= 1) {
    return { error: 'this duty is unreachable with the stated number of shell passes' };
  }
  const root = Math.sqrt(r * r + 1);
  let f;
  if (Math.abs(r - 1) < 1e-9) {
    // R = 1 limit: ln((1-P)/(1-PR))/(R-1) -> P/(1-P), and the
    // logarithm's arguments carry -1-R = -2. (Writing -1 there instead
    // of -2 is a silent 20 percent error at P = 0.5; the oracle caught
    // exactly that.)
    const num = (p1 * root) / (1 - p1);
    const a = 2 / p1 - 2 + root;
    const b = 2 / p1 - 2 - root;
    if (!(b > 0)) {
      return { error: 'F is undefined for this P and R: the configuration cannot reach this duty, add shell passes' };
    }
    f = num / Math.log(a / b);
  } else {
    const num = (root / (r - 1)) * Math.log((1 - p1) / (1 - p1 * r));
    const a = 2 / p1 - 1 - r + root;
    const b = 2 / p1 - 1 - r - root;
    if (!(b > 0)) {
      return { error: 'F is undefined for this P and R: the configuration cannot reach this duty, add shell passes' };
    }
    f = num / Math.log(a / b);
  }
  if (!Number.isFinite(f) || f <= 0 || f > 1.0001) {
    return { error: 'F is undefined for this P and R: the configuration cannot reach this duty, add shell passes' };
  }
  return {
    f: Math.min(f, 1),
    shellPasses: n,
    warning: f < 0.8
      ? 'F below 0.8: the correction curve is steep here, so a small error in the terminal temperatures swings the area badly. Add a shell pass rather than accepting this.'
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * Overall coefficient from named resistances
 * ------------------------------------------------------------------ */

/**
 * U referred to the OUTSIDE area, assembled from its parts so the
 * controlling resistance is visible instead of buried:
 *   1/Uo = 1/ho + Rfo + (do ln(do/di))/(2 kw) + (do/di)(Rfi + 1/hi)
 */
export const overallU = ({
  hoBtuHrFt2F, hiBtuHrFt2F, doIn, diIn,
  kWallBtuHrFtF = 26, foulingOut = 0, foulingIn = 0,
}) => {
  if (!(hoBtuHrFt2F > 0) || !(hiBtuHrFt2F > 0) || !(doIn > diIn) || !(diIn > 0)) {
    return { error: 'U needs positive film coefficients and do greater than di' };
  }
  const ratio = doIn / diIn;
  const rOut = 1 / hoBtuHrFt2F;
  const rWall = (doIn / 12) * Math.log(ratio) / (2 * kWallBtuHrFtF);
  const rIn = ratio / hiBtuHrFt2F;
  const rFoulIn = ratio * foulingIn;
  const total = rOut + foulingOut + rWall + rIn + rFoulIn;
  const parts = {
    outsideFilm: rOut, outsideFouling: foulingOut, wall: rWall,
    insideFilm: rIn, insideFouling: rFoulIn,
  };
  const controlling = Object.entries(parts).sort((a, b) => b[1] - a[1])[0][0];
  return {
    uCleanBtuHrFt2F: 1 / (rOut + rWall + rIn),
    uDirtyBtuHrFt2F: 1 / total,
    resistances: parts,
    controlling,
    foulingPenaltyPct: (1 - (1 / total) / (1 / (rOut + rWall + rIn))) * 100,
  };
};

/**
 * Tube-side film coefficient. Dittus-Boelter in fully turbulent flow;
 * the Sieder-Tate viscosity ratio applied when a wall viscosity is
 * given. Below Re 2300 the laminar constant-wall-temperature Nusselt
 * of 3.66 is used, and the transition band is REFUSED rather than
 * interpolated, because no correlation there is trustworthy and
 * pretending otherwise is how a design gets sized on a fiction.
 */
export const tubeSideFilm = ({
  mLbHr, diIn, muCp, kBtuHrFtF, cpBtuLbF, muWallCp, nTubes = 1, passes = 1,
}) => {
  if (!(mLbHr > 0) || !(diIn > 0) || !(muCp > 0) || !(kBtuHrFtF > 0) || !(cpBtuLbF > 0)) {
    return { error: 'the tube-side film needs positive flow, bore and fluid properties' };
  }
  const tubesPerPass = Math.max(1, nTubes / Math.max(1, passes));
  const dFt = diIn / 12;
  const areaFt2 = (Math.PI * dFt * dFt) / 4 * tubesPerPass;
  const gLbHrFt2 = mLbHr / areaFt2;             // mass velocity
  const muLbFtHr = muCp * 2.4191;                // cp -> lb/(ft.hr)
  const re = (dFt * gLbHrFt2) / muLbFtHr;
  const pr = (cpBtuLbF * muLbFtHr) / kBtuHrFtF;
  if (re < 2300) {
    return {
      re, pr, regime: 'laminar',
      hBtuHrFt2F: 3.66 * kBtuHrFtF / dFt,
      warning: 'laminar tube side: the constant-wall-temperature limit is used and entrance effects are ignored',
    };
  }
  if (re < 10000) {
    return {
      error: `tube-side Reynolds ${Math.round(re)} is in the transition band (2300 to 10000): no film correlation is trustworthy here. Change the tube count, the passes or the bore to leave it.`,
      re, pr,
    };
  }
  const nu0 = 0.023 * re ** 0.8 * pr ** 0.4;
  const phi = muWallCp > 0 ? (muCp / muWallCp) ** 0.14 : 1;
  return {
    re, pr, regime: 'turbulent',
    hBtuHrFt2F: (nu0 * phi * kBtuHrFtF) / dFt,
    siederTate: phi !== 1,
  };
};

/* ------------------------------------------------------------------ *
 * Sizing and rating
 * ------------------------------------------------------------------ */

/** Area from Q = U A F dTlm. */
export const areaRequired = ({ qBtuHr, uBtuHrFt2F, lmtdF, f = 1 }) => {
  if (!(qBtuHr > 0) || !(uBtuHrFt2F > 0) || !(lmtdF > 0) || !(f > 0)) {
    return { error: 'area needs a positive duty, U, LMTD and F' };
  }
  return { areaFt2: qBtuHr / (uBtuHrFt2F * f * lmtdF) };
};

/**
 * Tube count and bundle diameter for a stated area. The bundle fit is
 * the standard D_b = do (N/K1)^(1/n1) form with the published
 * constants for the common layouts and pass counts; the shell is the
 * bundle plus a clearance that is an input, since it depends on the
 * TEMA head type.
 */
const BUNDLE_K = {
  '30': { 1: { k: 0.319, n: 2.142 }, 2: { k: 0.249, n: 2.207 }, 4: { k: 0.175, n: 2.285 }, 6: { k: 0.0743, n: 2.499 } },
  '45': { 1: { k: 0.215, n: 2.207 }, 2: { k: 0.156, n: 2.291 }, 4: { k: 0.158, n: 2.263 }, 6: { k: 0.0402, n: 2.617 } },
  '90': { 1: { k: 0.215, n: 2.207 }, 2: { k: 0.156, n: 2.291 }, 4: { k: 0.158, n: 2.263 }, 6: { k: 0.0402, n: 2.617 } },
};

export const tubeCount = ({
  areaFt2, doIn, tubeLengthFt, layoutDeg = 30, passes = 2, bundleClearanceIn = 2.5,
}) => {
  if (!(areaFt2 > 0) || !(doIn > 0) || !(tubeLengthFt > 0)) {
    return { error: 'tube count needs a positive area, tube OD and length' };
  }
  const perTube = Math.PI * (doIn / 12) * tubeLengthFt;
  const n = Math.ceil(areaFt2 / perTube);
  const layout = BUNDLE_K[String(layoutDeg)];
  if (!layout) return { error: `no published bundle constants for a ${layoutDeg} degree layout` };
  const passKey = [1, 2, 4, 6].includes(passes) ? passes : null;
  if (!passKey) return { error: 'bundle constants are published for 1, 2, 4 and 6 tube passes' };
  const { k, n: n1 } = layout[passKey];
  const bundleIn = doIn * (n / k) ** (1 / n1);
  return {
    nTubes: n,
    areaPerTubeFt2: perTube,
    actualAreaFt2: n * perTube,
    bundleDiameterIn: bundleIn,
    shellDiameterIn: bundleIn + bundleClearanceIn,
  };
};

/**
 * Effectiveness-NTU, both directions, for the arrangements whose
 * closed forms are published.
 */
export const effectivenessFromNtu = ({ ntu, cr, arrangement = 'counter' }) => {
  if (!(ntu >= 0) || !(cr >= 0) || cr > 1) return NaN;
  if (cr === 0) return 1 - Math.exp(-ntu);
  if (arrangement === 'parallel') {
    return (1 - Math.exp(-ntu * (1 + cr))) / (1 + cr);
  }
  if (arrangement === 'shell1') {
    // one shell pass, 2/4/... tube passes
    const root = Math.sqrt(1 + cr * cr);
    const e = Math.exp(-ntu * root);
    return 2 / (1 + cr + root * (1 + e) / (1 - e));
  }
  // counter-current
  if (Math.abs(cr - 1) < 1e-9) return ntu / (1 + ntu);
  const e = Math.exp(-ntu * (1 - cr));
  return (1 - e) / (1 - cr * e);
};

export const ntuFromEffectiveness = ({ effectiveness: eff, cr, arrangement = 'counter' }) => {
  if (!(eff > 0) || eff >= 1) return { error: 'effectiveness must be between 0 and 1' };
  if (!(cr >= 0) || cr > 1) return { error: 'the capacity ratio must be between 0 and 1' };
  if (cr === 0) return { ntu: -Math.log(1 - eff) };
  if (arrangement === 'parallel') {
    const inner = 1 - eff * (1 + cr);
    if (!(inner > 0)) {
      return { error: `a parallel-flow exchanger cannot exceed an effectiveness of ${(1 / (1 + cr)).toFixed(3)} at this capacity ratio, whatever its area` };
    }
    return { ntu: -Math.log(inner) / (1 + cr) };
  }
  if (arrangement === 'shell1') {
    const root = Math.sqrt(1 + cr * cr);
    const emax = 2 / (1 + cr + root);
    if (eff >= emax) {
      return { error: `a 1-2 shell exchanger cannot exceed an effectiveness of ${emax.toFixed(3)} at this capacity ratio, whatever its area` };
    }
    const e = (2 / eff - (1 + cr)) / root;
    return { ntu: (1 / root) * Math.log((e + 1) / (e - 1)) };
  }
  if (Math.abs(cr - 1) < 1e-9) return { ntu: eff / (1 - eff) };
  return { ntu: (1 / (cr - 1)) * Math.log((eff - 1) / (eff * cr - 1)) };
};

/* ------------------------------------------------------------------ *
 * Air coolers
 * ------------------------------------------------------------------ */

/** Air properties at the mean temperature (ideal, at 14.7 psia). */
export const airDensityLbFt3 = (tF) => (14.7 * 28.9625) / (10.7316 * (tF + 459.67));

/**
 * Air cooler sizing with the fan power from the air the duty actually
 * needs, plus the DESIGN-AMBIENT DERATE: an air cooler is sized on a
 * design ambient it will exceed some days, and its capacity falls
 * linearly with the approach it loses. Reporting the summer capacity
 * beside the design one is the honest answer, because that is what
 * limits the plant in August.
 */
export const airCooler = ({
  qBtuHr, processInF, processOutF, ambientF, airRiseF,
  uBtuHrFt2F, staticPressureInH2O = 0.6, fanEfficiency = 0.65,
  motorEfficiency = 0.92, checkAmbientF,
}) => {
  if (!(qBtuHr > 0) || !(uBtuHrFt2F > 0) || !(airRiseF > 0)) {
    return { error: 'an air cooler needs a positive duty, U and air temperature rise' };
  }
  const airOutF = ambientF + airRiseF;
  const l = lmtd({ thIn: processInF, thOut: processOutF, tcIn: ambientF, tcOut: airOutF });
  if (l.error) return l;
  const areaFt2 = qBtuHr / (uBtuHrFt2F * l.lmtdF);
  const cpAir = 0.24;
  const airLbHr = qBtuHr / (cpAir * airRiseF);
  const rho = airDensityLbFt3((ambientF + airOutF) / 2);
  const acfm = airLbHr / rho / 60;
  // fan bhp = ACFM * static inches of water / (6356 * eta)
  const fanBhp = (acfm * staticPressureInH2O) / (6356 * fanEfficiency);
  const out = {
    airOutF,
    lmtdF: l.lmtdF,
    areaFt2,
    airLbHr,
    acfm,
    airDensityLbFt3: rho,
    fanBhp,
    motorHp: fanBhp / motorEfficiency,
  };
  if (Number.isFinite(checkAmbientF)) {
    // Same air mass and same UA; the approach shrinks with the hotter
    // ambient, so the achievable duty falls with the driving force.
    const hotAirOut = checkAmbientF + airRiseF;
    const l2 = lmtd({ thIn: processInF, thOut: processOutF, tcIn: checkAmbientF, tcOut: hotAirOut });
    out.hotDay = l2.error
      ? { error: `at ${checkAmbientF} F ambient this outlet temperature is unreachable: the air is no longer cold enough to take the process below ${processOutF} F` }
      : {
        ambientF: checkAmbientF,
        lmtdF: l2.lmtdF,
        dutyFraction: l2.lmtdF / l.lmtdF,
        qBtuHr: qBtuHr * (l2.lmtdF / l.lmtdF),
      };
  }
  return out;
};
