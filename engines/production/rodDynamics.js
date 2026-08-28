/**
 * Rod string dynamics: the damped wave equation (Production P6).
 *
 * A sucker rod string is a long elastic bar. What happens in it is
 * governed by the one-dimensional wave equation with viscous damping,
 *
 *     d2u/dt2 = a^2 d2u/dx2 - kappa du/dt
 *
 * and everything a rod-pump design needs is a consequence of solving
 * it: how much of the surface stroke reaches the plunger, what the
 * polished rod load does through the cycle, and therefore the peak and
 * minimum loads, the torque and the power.
 *
 * WHY THIS MODULE SOLVES THE EQUATION RATHER THAN READING API RP 11L.
 * RP 11L predicts the same quantities from dimensionless charts. Those
 * charts ARE solutions of this equation, computed once and plotted.
 * Reproducing plotted curves from memory is the failure this package
 * refuses elsewhere (see the Hydraulic Institute note in espPump), and
 * there is no need to take the risk here: the equation itself is
 * first-principles physics and can be solved directly. So the solution
 * is computed, the RP 11L dimensionless groups are reported alongside
 * it because they are how the answer is read, and the published charts
 * stay a LITERATURE GATE for when the document is to hand.
 *
 * TWO SOLVERS, TWO ROUTES, ON PURPOSE.
 *
 *  predictCard    the design problem. Surface motion is known (the
 *                 unit's geometry gives it) and the pump end is a
 *                 force condition. Solved by explicit finite
 *                 differences marched to periodic steady state.
 *
 *  diagnoseCard   the measurement problem, which is Gibbs' 1963
 *                 contribution. BOTH the position and the load are
 *                 known at the surface, from a dynamometer, and the
 *                 question is what the pump is doing. Each Fourier
 *                 harmonic of the measured card propagates down the
 *                 string in closed form, so this is solved
 *                 analytically per harmonic and summed.
 *
 * The two share no code path, which is what makes the round trip a
 * real check: predict a card, hand the surface half of it to the
 * diagnostic solver, and the pump card it returns has to be the one
 * the prediction assumed.
 *
 * SIGN AND UNIT CONVENTIONS, fixed once here:
 *   x   ft, measured DOWNWARD from the polished rod, x = L at the pump
 *   u   ft, displacement, positive DOWNWARD, measured as a deviation
 *       from the statically stretched hanging position
 *   T   lbf, dynamic tension, T = EA du/dx, positive in tension
 *   PRL lbf, total polished rod load = buoyed rod weight + T(0,t)
 * Working in deviations from static equilibrium is what keeps gravity
 * out of the marching scheme: it is already in the static solution.
 */

import { ROD_ELASTIC_MODULUS_PSI } from './data/rodCatalog.js';
import { sectionWaveSpeedFtS, G_FT_S2 } from './rodString.js';

/**
 * Damping, stated as a fraction of critical for the string's
 * fundamental mode.
 *
 * kappa is not derivable: it stands for viscous drag on the rods, the
 * fluid they move through and mechanical friction, and real predictive
 * codes calibrate it against a measured card. Expressing it as a
 * damping RATIO rather than a raw coefficient at least makes it a
 * number with a meaning — zeta = 1 is critical damping of the
 * fundamental — so a value can be judged rather than merely typed.
 * Field strings sit around 0.05 to 0.15.
 *
 *   omega0 = pi a / (2 L)      the quarter-wave fundamental
 *   kappa  = 2 zeta omega0 = zeta pi a / L
 */
export const DEFAULT_DAMPING_RATIO = 0.10;

export const dampingCoefficient = ({ dampingRatio, waveSpeedFtS, lengthFt }) =>
  (Number(dampingRatio) * Math.PI * waveSpeedFtS) / lengthFt;

/** Discretise the string onto a uniform grid of nodes. */
const buildGrid = ({ string, nodes }) => {
  const L = string.lengthFt;
  const n = Math.max(8, Math.round(nodes));
  const dx = L / n;
  // Depth of each node and of each face between nodes.
  const sectionAt = (depthFt) => {
    let acc = 0;
    for (const s of string.sections) {
      acc += s.lengthFt;
      if (depthFt <= acc + 1e-9) return s;
    }
    return string.sections[string.sections.length - 1];
  };
  // EA at faces (i+1/2), mass per length at nodes.
  const eaFace = new Float64Array(n);      // between node i and i+1
  for (let i = 0; i < n; i += 1) {
    const s = sectionAt((i + 0.5) * dx);
    eaFace[i] = ROD_ELASTIC_MODULUS_PSI * s.areaIn2;
  }
  const massNode = new Float64Array(n + 1); // slug/ft
  for (let i = 0; i <= n; i += 1) {
    const s = sectionAt(Math.min(i * dx, L));
    massNode[i] = s.weightLbPerFt / G_FT_S2;
  }
  const aMax = Math.max(...string.sections.map((s) => sectionWaveSpeedFtS(s)));
  return { n, dx, eaFace, massNode, aMax, L };
};

/**
 * The pump end, as a four-state machine over one stroke.
 *
 * The fluid load is a REACTION, not a force that can be switched on.
 * That distinction is the whole of this boundary condition. Applying
 * Fo to the plunger the instant the stroke reverses would push the
 * plunger down, which nothing in the well does, and it would hand the
 * string a step load it then rings on; the plunger stroke that comes
 * out is too long and the loads too extreme.
 *
 * What actually happens at the bottom of the stroke is that the
 * traveling valve shuts and the plunger STAYS WHERE IT IS while the
 * polished rod moves up and the rod string stretches. Only when the
 * tension just above the plunger has built to Fo does the plunger
 * begin to lift. That held period is why the plunger stroke is shorter
 * than the surface stroke by the rod stretch, and it is the reason the
 * transfer is modelled as a constraint here rather than as a load.
 *
 *   TRANSFER_UP    surface has turned up; plunger CLAMPED; the tension
 *                  above it is the reaction. Releases at Fo.
 *   LIFTING        plunger free, carrying Fo.
 *   POUND_DOWN     surface has turned down but the traveling valve
 *                  cannot open yet: with a partly filled barrel the
 *                  plunger has to travel down through the empty part
 *                  first, carrying Fo the whole way. With a full
 *                  barrel this state is passed through instantly. The
 *                  cliff at the end of it is fluid pound, arrived at
 *                  from the fillage rather than drawn to look like
 *                  itself.
 *   TRANSFER_ZERO  the valve is open; plunger CLAMPED again while the
 *                  stretched string gives its load back and shortens.
 *                  Releases at zero tension.
 *   FALLING        plunger free, carrying nothing.
 *
 * BOTH transfers hold the plunger still, and that is what makes the
 * downhole card the familiar parallelogram: the two vertical sides ARE
 * the two transfers. It is also what makes the plunger stroke shorter
 * than the surface stroke by exactly the rod stretch in thestatic limit,
 * Sp = S - Fo Er, which is the gate on this whole module.
 *
 * Stroke reversals are taken from the SURFACE motion, which is known
 * analytically and therefore noise-free. Reading them off the computed
 * plunger velocity instead is what an earlier draft of this module did,
 * and near a reversal the per-step change in plunger position is
 * smaller than the scheme's own round-off, so the valve chattered, the
 * string saw the mean of the two loads and the polished rod load came
 * out pinned at Wrf + Fo/2 for every speed. The lesson is kept here
 * deliberately: switch on the quantity that is known exactly.
 */
const PUMP_STATE = {
  TRANSFER_UP: 'transferUp',
  LIFTING: 'lifting',
  POUND_DOWN: 'poundDown',
  TRANSFER_ZERO: 'transferZero',
  FALLING: 'falling',
};

/**
 * Predictive solve: the design problem.
 *
 * inputs: {
 *   string          from rodString.buildRodString
 *   surfacePosition (tFrac) => polished rod position in FEET, measured
 *                   down from the top of the stroke, over one cycle
 *                   (tFrac in [0,1)). The unit geometry supplies this.
 *   strokeFt        surface stroke length, ft
 *   spm             pumping speed, strokes per minute
 *   fluidLoadLb     Fo, the fluid load carried by the plunger
 *   fillage         barrel fill fraction, 1 for a full pump
 *   dampingRatio    fraction of critical for the fundamental
 *   nodes           spatial nodes (default 60)
 *   maxCycles       cycles to march before giving up on periodicity
 *   tol             periodicity tolerance, ft
 * }
 *
 * returns {
 *   ok, converged, cycles, samples,
 *   surfaceCard: [{ positionIn, loadLb, tFrac }],
 *   pumpCard:    [{ positionIn, loadLb, tFrac }],
 *   plungerStrokeIn, prlPeakLb, prlMinLb, workInLbPerCycle,
 *   waveSpeedFtS, kappaPerS, dt, warnings
 * }
 */
export const predictCard = ({
  string, surfacePosition, strokeFt, spm, fluidLoadLb, fillage = 1,
  dampingRatio = DEFAULT_DAMPING_RATIO, nodes = 120, maxCycles = 20, tol = 1e-4,
  cardSamples = 180,
}) => {
  const warnings = [];
  // Damping is a precondition, not a numerical detail. With none, a
  // periodically driven string never settles: the transient from every
  // valve transfer survives to the next one, the plunger stroke grows
  // without bound and the loads come out confident and meaningless. So
  // a non-positive ratio is refused here rather than marched.
  if (!(Number(dampingRatio) > 0)) {
    return {
      ok: false,
      error: `A damping ratio of ${dampingRatio} cannot be solved: with no damping the string never settles into a repeating stroke. Field strings sit between about 0.05 and 0.15 of critical.`,
      warnings: [],
    };
  }
  const grid = buildGrid({ string, nodes });
  const { n, dx, eaFace, massNode, aMax, L } = grid;
  const period = 60 / spm;                       // s
  const kappa = dampingCoefficient({
    dampingRatio, waveSpeedFtS: aMax, lengthFt: L,
  });

  // Courant condition on the fastest section, with margin.
  const dtCfl = dx / aMax;
  const stepsPerCycle = Math.max(240, Math.ceil(period / (0.4 * dtCfl)));
  const dt = period / stepsPerCycle;
  if (dt > dtCfl) {
    warnings.push({
      code: 'timestep',
      message: 'The time step exceeded the Courant limit and was not stable; increase the node count.',
    });
  }

  let uPrev = new Float64Array(n + 1);
  let uCur = new Float64Array(n + 1);
  let uNext = new Float64Array(n + 1);

  // Pump-end state, carried across steps.
  let plungerTopFt = 0;
  let pumpState = PUMP_STATE.FALLING;
  let plungerStrokeFtPrev = strokeFt;

  // Surface direction, from the prescribed motion rather than from the
  // solution: exact, and the only robust trigger for a reversal.
  const surfaceMovingDown = (tFrac) => {
    const h = 1 / (4 * stepsPerCycle);
    const ahead = surfacePosition((tFrac + h) % 1);
    const behind = surfacePosition((tFrac - h + 1) % 1);
    return ahead > behind;
  };
  let plungerStrokeFt = strokeFt;                // seed; refined each cycle

  const damp = 1 + (kappa * dt) / 2;

  let surfaceWasDown = true;
  let converged = false;
  let cyclesRun = 0;
  let lastCycle = null;
  let lastEnvelope = null;

  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const record = [];
    let plungerMin = Infinity;
    let plungerMax = -Infinity;
    // Peak and minimum tension at every node over the cycle. A taper is
    // designed so each section carries the same peak stress, so the
    // envelope along the string is the thing that check needs.
    const tMaxNode = new Float64Array(n + 1).fill(-Infinity);
    const tMinNode = new Float64Array(n + 1).fill(Infinity);
    const uAtCycleStart = Float64Array.from(uCur);

    for (let step = 0; step < stepsPerCycle; step += 1) {
      const tFrac = step / stepsPerCycle;
      const tFracNext = (step + 1) / stepsPerCycle;

      // --- interior nodes ---
      for (let i = 1; i < n; i += 1) {
        const tUp = (eaFace[i - 1] * (uCur[i] - uCur[i - 1])) / dx;
        const tDown = (eaFace[i] * (uCur[i + 1] - uCur[i])) / dx;
        const accel = (tDown - tUp) / (dx * massNode[i]);
        uNext[i] = (2 * uCur[i] - uPrev[i]
          + dt * dt * accel + ((kappa * dt) / 2) * uPrev[i]) / damp;
      }

      // --- pump end: constraint or force, by valve state ---
      const downNow = surfaceMovingDown(tFrac);
      if (downNow && !surfaceWasDown) {
        pumpState = PUMP_STATE.POUND_DOWN;
        plungerTopFt = uCur[n];
      } else if (!downNow && surfaceWasDown) {
        pumpState = PUMP_STATE.TRANSFER_UP;
      }
      surfaceWasDown = downNow;

      const tUpN = (eaFace[n - 1] * (uCur[n] - uCur[n - 1])) / dx;
      const halfMass = massNode[n] * (dx / 2);

      if (pumpState === PUMP_STATE.TRANSFER_UP && tUpN >= fluidLoadLb) {
        pumpState = PUMP_STATE.LIFTING;
      }
      if (pumpState === PUMP_STATE.POUND_DOWN) {
        const emptyFt = Math.max(0, 1 - fillage) * plungerStrokeFtPrev;
        if (uCur[n] - plungerTopFt >= emptyFt) pumpState = PUMP_STATE.TRANSFER_ZERO;
      }
      if (pumpState === PUMP_STATE.TRANSFER_ZERO && tUpN <= 0) {
        pumpState = PUMP_STATE.FALLING;
      }

      const clamped = pumpState === PUMP_STATE.TRANSFER_UP
        || pumpState === PUMP_STATE.TRANSFER_ZERO;
      let fPump;
      if (clamped) {
        // The plunger is held by the fluid it is handing over; the rod
        // above it takes up the difference by stretching or relaxing.
        uNext[n] = uCur[n];
        fPump = tUpN;
      } else {
        fPump = pumpState === PUMP_STATE.FALLING ? 0 : fluidLoadLb;
        const accelN = (fPump - tUpN) / halfMass;
        uNext[n] = (2 * uCur[n] - uPrev[n] + dt * dt * accelN
          + ((kappa * dt) / 2) * uPrev[n]) / damp;
      }

      // --- surface, prescribed motion ---
      uNext[0] = surfacePosition(tFracNext) - surfacePosition(0);

      // Record on the current step, before rotating. The surface
      // tension is a one-sided derivative at the boundary, so it is
      // taken to SECOND order: a plain two-point difference is only
      // first-order accurate there and smears the load transfer, which
      // is exactly where the peak and minimum loads are set.
      const prlDyn = (eaFace[0] * (-3 * uCur[0] + 4 * uCur[1] - uCur[2])) / (2 * dx);
      record.push({
        tFrac,
        surfaceFt: surfacePosition(tFrac),
        prlDynLb: prlDyn,
        plungerFt: uCur[n],
        pumpLoadLb: fPump,
      });
      if (uCur[n] < plungerMin) plungerMin = uCur[n];
      if (uCur[n] > plungerMax) plungerMax = uCur[n];
      for (let i = 0; i < n; i += 1) {
        const t = (eaFace[i] * (uCur[i + 1] - uCur[i])) / dx;
        if (t > tMaxNode[i]) tMaxNode[i] = t;
        if (t < tMinNode[i]) tMinNode[i] = t;
      }

      const rot = uPrev; uPrev = uCur; uCur = uNext; uNext = rot;
    }

    cyclesRun = cycle + 1;
    plungerStrokeFt = Math.max(plungerMax - plungerMin, 1e-9);
    plungerStrokeFtPrev = plungerStrokeFt;
    lastCycle = record;
    lastEnvelope = { tMaxNode, tMinNode };

    // Periodic steady state: the whole string repeats itself.
    let drift = 0;
    for (let i = 0; i <= n; i += 1) {
      drift = Math.max(drift, Math.abs(uCur[i] - uAtCycleStart[i]));
    }
    // Relative to the stroke: the valve transfer lands on a discrete
    // time step, so the cycle repeats to within a step's worth of
    // motion rather than exactly, and demanding more than that would
    // report a converged solution as unconverged forever.
    if (cycle >= 2 && drift < tol * strokeFt) { converged = true; break; }
  }

  if (!converged) {
    warnings.push({
      code: 'notPeriodic',
      message: `The solution had not settled into a repeating cycle after ${cyclesRun} strokes. Its loads are indicative; raise the damping or check the inputs.`,
    });
  }

  // --- assemble the cards ---
  // The march runs at the Courant step, which is far finer than a card
  // needs; the cards are decimated to a workable number of points so
  // both the studio and the Fourier diagnostic get an even sampling.
  const stride = Math.max(1, Math.floor(lastCycle.length / cardSamples));
  const sampled = lastCycle.filter((_, i) => i % stride === 0);
  const wRf = string.weightFluidLb;
  const surfaceCard = sampled.map((r) => ({
    tFrac: r.tFrac,
    positionIn: (r.surfaceFt - sampled[0].surfaceFt) * 12,
    loadLb: wRf + r.prlDynLb,
  }));
  const plungerRef = Math.min(...sampled.map((r) => r.plungerFt));
  const pumpCard = sampled.map((r) => ({
    tFrac: r.tFrac,
    positionIn: (r.plungerFt - plungerRef) * 12,
    loadLb: r.pumpLoadLb,
  }));

  const loads = surfaceCard.map((p) => p.loadLb);
  const prlPeakLb = Math.max(...loads);
  const prlMinLb = Math.min(...loads);
  const plungerStrokeIn = plungerStrokeFt * 12;

  // Static weight carried at each depth, so the envelope can be
  // reported as total tension rather than as a deviation.
  const staticBelow = (depthFt) => {
    let acc = 0;
    let seen = 0;
    for (const sec of string.sections) {
      const top = seen;
      const bot = seen + sec.lengthFt;
      const from = Math.max(depthFt, top);
      if (bot > from) acc += sec.weightLbPerFt * (bot - from) * string.buoyancy;
      seen = bot;
    }
    return acc;
  };
  const tensionEnvelope = [];
  for (let i = 0; i < n; i += 1) {
    const depthFt = (i + 0.5) * dx;
    const stat = staticBelow(depthFt);
    tensionEnvelope.push({
      depthFt,
      maxLb: stat + lastEnvelope.tMaxNode[i],
      minLb: stat + lastEnvelope.tMinNode[i],
    });
  }

  return {
    ok: true,
    converged,
    cycles: cyclesRun,
    samples: stepsPerCycle,
    tensionEnvelope,
    surfaceCard,
    pumpCard,
    plungerStrokeIn,
    prlPeakLb,
    prlMinLb,
    workInLbPerCycle: cardArea(surfaceCard),
    waveSpeedFtS: aMax,
    kappaPerS: kappa,
    dt,
    warnings,
  };
};

/**
 * Area enclosed by a card, in-lb per cycle, by the shoelace formula.
 * A dynamometer card is a closed loop of load against position, and
 * the work done per stroke is the area it encloses. Sign is taken
 * positive because the direction the loop is traversed depends only on
 * the plotting convention.
 */
export const cardArea = (card) => {
  let sum = 0;
  for (let i = 0; i < card.length; i += 1) {
    const p = card[i];
    const q = card[(i + 1) % card.length];
    sum += p.positionIn * q.loadLb - q.positionIn * p.loadLb;
  }
  return Math.abs(sum) / 2;
};

/** Polished rod horsepower from the card area and the speed. */
export const polishedRodHp = ({ workInLbPerCycle, spm }) =>
  (workInLbPerCycle * spm) / (12 * 33000);

// ---------------------------------------------------------------- Gibbs

/** Minimal complex helpers: the diagnostic solution is complex-valued. */
const cAdd = (a, b) => [a[0] + b[0], a[1] + b[1]];
const cMul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cDiv = (a, b) => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
const cSqrt = (a) => {
  const r = Math.hypot(a[0], a[1]);
  const re = Math.sqrt(Math.max((r + a[0]) / 2, 0));
  const im = Math.sign(a[1] || 1) * Math.sqrt(Math.max((r - a[0]) / 2, 0));
  return [re, im];
};
const cCos = (a) => [Math.cos(a[0]) * Math.cosh(a[1]), -Math.sin(a[0]) * Math.sinh(a[1])];
const cSin = (a) => [Math.sin(a[0]) * Math.cosh(a[1]), Math.cos(a[0]) * Math.sinh(a[1])];
const cScale = (a, k) => [a[0] * k, a[1] * k];

/** Discrete Fourier coefficients of a real, uniformly sampled cycle. */
export const fourierCoefficients = (values, harmonics) => {
  const N = values.length;
  const out = [];
  for (let k = 0; k <= harmonics; k += 1) {
    let re = 0;
    let im = 0;
    for (let j = 0; j < N; j += 1) {
      const ang = (-2 * Math.PI * k * j) / N;
      re += values[j] * Math.cos(ang);
      im += values[j] * Math.sin(ang);
    }
    out.push([re / N, im / N]);
  }
  return out;
};

/**
 * Diagnostic solve: what the pump is doing, from a measured surface
 * card. This is the Gibbs solution.
 *
 * Each harmonic of the measured position and load propagates down the
 * string in closed form. Writing u(x,t) = Re[U(x) e^{i omega t}], the
 * wave equation becomes U'' + beta^2 U = 0 with
 *
 *     beta = sqrt(omega^2 - i omega kappa) / a
 *
 * so through one uniform section the state (U, T) transfers by
 *
 *     U(x) = U0 cos(beta x) + T0 sin(beta x) / (EA beta)
 *     T(x) = -U0 EA beta sin(beta x) + T0 cos(beta x)
 *
 * and a tapered string is the product of those matrices, section by
 * section, matching displacement and force at each junction. The zero
 * harmonic is the static limit, where the section simply stretches:
 * U = U0 + T0 x / EA and T = T0.
 *
 * inputs: {
 *   string, surfaceCard (positionIn, loadLb, uniformly sampled over one
 *   cycle), spm, dampingRatio, harmonics
 * }
 * returns { ok, pumpCard, plungerStrokeIn, pumpLoadRangeLb, harmonics }
 */
export const diagnoseCard = ({
  string, surfaceCard, spm, dampingRatio = DEFAULT_DAMPING_RATIO, harmonics = 24,
}) => {
  const N = surfaceCard.length;
  if (N < 16) {
    return { ok: false, error: 'A dynamometer card needs at least sixteen samples to be read.' };
  }
  const L = string.lengthFt;
  const aMax = Math.max(...string.sections.map((s) => sectionWaveSpeedFtS(s)));
  const kappa = dampingCoefficient({ dampingRatio, waveSpeedFtS: aMax, lengthFt: L });
  const omega1 = (2 * Math.PI * spm) / 60;

  // Surface state in engine units: position ft (downward positive) and
  // DYNAMIC tension, which is the measured load less the buoyed rod
  // weight the static solution already carries.
  const wRf = string.weightFluidLb;
  const uSurf = surfaceCard.map((p) => p.positionIn / 12);
  const tSurf = surfaceCard.map((p) => p.loadLb - wRf);

  const nH = Math.min(harmonics, Math.floor(N / 2) - 1);
  const U0 = fourierCoefficients(uSurf, nH);
  const T0 = fourierCoefficients(tSurf, nH);

  // Propagate each harmonic to the pump end.
  const UL = [];
  const TL = [];
  for (let k = 0; k <= nH; k += 1) {
    let u = U0[k];
    let t = T0[k];
    for (const s of string.sections) {
      const ea = ROD_ELASTIC_MODULUS_PSI * s.areaIn2;
      const a = sectionWaveSpeedFtS(s);
      if (k === 0) {
        // Static limit: uniform tension, linear stretch.
        u = [u[0] + (t[0] * s.lengthFt) / ea, u[1] + (t[1] * s.lengthFt) / ea];
        continue;
      }
      const omega = omega1 * k;
      const beta = cScale(cSqrt([omega * omega, -omega * kappa]), 1 / a);
      const bx = cScale(beta, s.lengthFt);
      const cb = cCos(bx);
      const sb = cSin(bx);
      const eaBeta = cScale(beta, ea);
      const uNext = cAdd(cMul(u, cb), cDiv(cMul(t, sb), eaBeta));
      const tNext = cAdd(cScale(cMul(cMul(u, eaBeta), sb), -1), cMul(t, cb));
      u = uNext;
      t = tNext;
    }
    UL.push(u);
    TL.push(t);
  }

  // Rebuild the pump-end signals in time.
  const plungerFt = new Array(N).fill(0);
  const pumpLoadLb = new Array(N).fill(0);
  for (let j = 0; j < N; j += 1) {
    let uSum = UL[0][0];
    let tSum = TL[0][0];
    for (let k = 1; k <= nH; k += 1) {
      const ang = (2 * Math.PI * k * j) / N;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      // Real part of 2 * coefficient * e^{i ang}
      uSum += 2 * (UL[k][0] * c - UL[k][1] * s);
      tSum += 2 * (TL[k][0] * c - TL[k][1] * s);
    }
    plungerFt[j] = uSum;
    pumpLoadLb[j] = tSum;
  }

  const ref = Math.min(...plungerFt);
  const pumpCard = plungerFt.map((p, j) => ({
    tFrac: j / N,
    positionIn: (p - ref) * 12,
    loadLb: pumpLoadLb[j],
  }));

  return {
    ok: true,
    pumpCard,
    plungerStrokeIn: (Math.max(...plungerFt) - ref) * 12,
    pumpLoadRangeLb: [Math.min(...pumpLoadLb), Math.max(...pumpLoadLb)],
    harmonics: nH,
    kappaPerS: kappa,
  };
};
