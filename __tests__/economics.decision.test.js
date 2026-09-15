/**
 * Gates for the Economics decision-analysis engine
 * (engines/economics/decisionTree.js) and the VOI Analyzer layer on it
 * (engines/economics/voi.js).
 *
 * Three parts, per the EC0 brief:
 *   (c) every test the Suite carried for these modules, ported verbatim in
 *       intent (src/lib/__tests__/decisionTree.test.js, 16 cases, and
 *       src/utils/__tests__/voiCalculations.test.js, 10 cases), so the
 *       vendored copy is proven at least as covered as the original;
 *   (b) agreement with every case in the independent oracle's golden,
 *       test-data/economics/goldens/decision_cases.json, within a stated
 *       absolute tolerance: 1e-9 on every unrounded quantity (the oracle is
 *       exact rational arithmetic; the engine is binary floating point on
 *       the same inputs) and half a cent plus 1e-9 on the VOI Analyzer's
 *       two-decimal KPI strings;
 *   (a) closed-form identities the method must satisfy: 0 <= EVII <= EVPI,
 *       a useless signal is worth 0, a perfect signal is worth EVPI, EVII
 *       and VOI rise monotonically with signal accuracy, and the diagram
 *       tree values the KPIs exactly.
 *
 * Money is $MM. Tree paths are lists of branch indices from the root.
 */
import fs from 'fs';
import path from 'path';
import {
  rollback, evpi, evii, bestActionEmv, impliedPriors,
  buildInformationTree, payoffValue, DecisionTreeError,
} from '../engines/economics/decisionTree.js';
import { generateVoiData } from '../engines/economics/voi.js';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'economics', 'goldens', 'decision_cases.json'),
  'utf8',
));

const ABS = 1e-9;
const KPI = 0.005 + 1e-9;

const near = (actual, expected, tol, label) => {
  const gap = Math.abs(actual - expected);
  if (!(gap <= tol)) {
    throw new Error(`${label}: engine ${actual} vs oracle ${expected} (gap ${gap} > ${tol})`);
  }
};

/** Node at a path of branch indices; [] is the root. */
const nodeAt = (root, p) => p.reduce((n, i) => n.branches[i].node, root);
const branchAt = (root, p) => nodeAt(root, p.slice(0, -1)).branches[p[p.length - 1]];

const countNodes = (n) => 1 + (n.branches || []).reduce((s, b) => s + countNodes(b.node), 0);

/** Walk an engine-annotated tree against the oracle's flattened expectation. */
const expectTree = (r, expected, label) => {
  expect(countNodes(r)).toBe(expected.nodes.length);
  for (const n of expected.nodes) {
    const node = nodeAt(r, n.path);
    expect(node.type).toBe(n.type);
    near(node.emv, n.emv, ABS, `${label} node [${n.path}] emv`);
    if (n.type === 'decision') expect(node.bestBranchIndex).toBe(n.bestBranchIndex);
  }
  for (const b of expected.branches) {
    const br = branchAt(r, b.path);
    near(br.branchValue, b.branchValue, ABS, `${label} branch [${b.path}] value`);
    expect(br.onOptimalPath).toBe(b.onOptimalPath);
  }
  near(r.emv, expected.emv, ABS, `${label} root emv`);
  if (expected.bestBranchIndex !== undefined) expect(r.bestBranchIndex).toBe(expected.bestBranchIndex);
};

// ---------------------------------------------------------------------------
// (c) The Suite's decisionTree.test.js, ported.
// ---------------------------------------------------------------------------

const OUTCOMES = [
  { label: 'Success', probability: 0.3 },
  { label: 'Dry hole', probability: 0.7 },
];
const ACTIONS = [
  { label: 'Drill', cost: 40, payoffs: [300, -10] },
  { label: 'Farm out', cost: 0, payoffs: [60, 0] },
  { label: 'Do nothing', cost: 0, payoffs: [0, 0] },
];
const SIGNALS = [
  { label: 'Positive seismic', likelihoods: [0.8, 0.3] },
  { label: 'Negative seismic', likelihoods: [0.2, 0.7] },
];

const drillTree = {
  type: 'decision',
  label: 'Prospect decision',
  branches: [
    {
      label: 'Drill', cost: 40,
      node: {
        type: 'chance', label: 'Drill outcome',
        branches: [
          { label: 'Success', probability: 0.3, node: { type: 'terminal', label: 'Success', payoff: 300 } },
          { label: 'Dry hole', probability: 0.7, node: { type: 'terminal', label: 'Dry', payoff: -10 } },
        ],
      },
    },
    {
      label: 'Farm out', cost: 0,
      node: {
        type: 'chance', label: 'Farm-out outcome',
        branches: [
          { label: 'Success', probability: 0.3, node: { type: 'terminal', label: 'Success', payoff: 60 } },
          { label: 'Dry hole', probability: 0.7, node: { type: 'terminal', label: 'Dry', payoff: 0 } },
        ],
      },
    },
    { label: 'Do nothing', cost: 0, node: { type: 'terminal', label: 'Walk away', payoff: 0 } },
  ],
};

describe('Suite port: rollback (hand-derived closed forms)', () => {
  it('solves the drill / farm-out prospect: EMV 43, drill optimal', () => {
    const r = rollback(drillTree);
    expect(r.emv).toBeCloseTo(43, 9);
    expect(r.bestBranchIndex).toBe(0);
    expect(r.branches[0].branchValue).toBeCloseTo(43, 9);
    expect(r.branches[1].branchValue).toBeCloseTo(18, 9);
    expect(r.branches[2].branchValue).toBeCloseTo(0, 9);
  });

  it('marks the optimal path through decisions and all chance branches under it', () => {
    const r = rollback(drillTree);
    expect(r.branches[0].onOptimalPath).toBe(true);
    expect(r.branches[1].onOptimalPath).toBe(false);
    expect(r.branches[0].node.branches.every((b) => b.onOptimalPath)).toBe(true);
    expect(r.branches[1].node.branches.every((b) => b.onOptimalPath === false)).toBe(true);
  });

  it('solves a two-stage sequential tree', () => {
    const tree = {
      type: 'decision', label: 'root',
      branches: [{
        label: 'Test', cost: 5,
        node: {
          type: 'chance', label: 'test result',
          branches: [
            {
              label: 'Good', probability: 0.4,
              node: {
                type: 'decision', label: 'after good',
                branches: [
                  { label: 'Develop', cost: 50, node: { type: 'terminal', payoff: 200 } },
                  { label: 'Sell', cost: 0, node: { type: 'terminal', payoff: 80 } },
                ],
              },
            },
            { label: 'Bad', probability: 0.6, node: { type: 'terminal', payoff: 20 } },
          ],
        },
      }],
    };
    const r = rollback(tree);
    expect(r.emv).toBeCloseTo(67, 9);
    expect(r.branches[0].node.branches[0].node.bestBranchIndex).toBe(0);
  });

  it('uses the mean of a distribution payoff (EMV is linear)', () => {
    expect(payoffValue({ mean: 135.2, p90: 40, p50: 130, p10: 240, ref: 'mc-run' })).toBe(135.2);
    const r = rollback({
      type: 'chance', label: 'c',
      branches: [
        { label: 'a', probability: 0.5, node: { type: 'terminal', payoff: { mean: 100 } } },
        { label: 'b', probability: 0.5, node: { type: 'terminal', payoff: 50 } },
      ],
    });
    expect(r.emv).toBeCloseTo(75, 9);
  });

  it('rejects chance probabilities that do not sum to 1', () => {
    expect(() => rollback({
      type: 'chance', label: 'bad',
      branches: [
        { label: 'a', probability: 0.5, node: { type: 'terminal', payoff: 1 } },
        { label: 'b', probability: 0.4, node: { type: 'terminal', payoff: 1 } },
      ],
    })).toThrow(DecisionTreeError);
  });
});

describe('Suite port: EVPI (hand-derived)', () => {
  it('computes EVPI = 35 for the prospect', () => {
    const r = evpi(OUTCOMES, ACTIONS);
    expect(r.emvPrior).toBeCloseTo(43, 9);
    expect(r.evWithPerfect).toBeCloseTo(78, 9);
    expect(r.evpi).toBeCloseTo(35, 9);
  });
});

describe('Suite port: EVII via Bayes (hand-derived)', () => {
  it('derives signal marginals, posteriors, and EVII = 12.5', () => {
    const r = evii(OUTCOMES, ACTIONS, SIGNALS, 5);
    expect(r.perSignal[0].pSignal).toBeCloseTo(0.45, 9);
    expect(r.perSignal[1].pSignal).toBeCloseTo(0.55, 9);
    expect(r.perSignal[0].posterior[0]).toBeCloseTo(8 / 15, 9);
    expect(r.perSignal[1].posterior[0]).toBeCloseTo(6 / 55, 9);
    expect(r.perSignal[0].bestActionIndex).toBe(0);
    expect(r.perSignal[1].bestActionIndex).toBe(1);
    expect(r.evWithInfo).toBeCloseTo(55.5, 9);
    expect(r.evii).toBeCloseTo(12.5, 9);
    expect(r.netEvii).toBeCloseTo(7.5, 9);
  });

  it('bounds: 0 <= EVII <= EVPI', () => {
    const { evii: gross } = evii(OUTCOMES, ACTIONS, SIGNALS);
    const { evpi: perfect } = evpi(OUTCOMES, ACTIONS);
    expect(gross).toBeGreaterThanOrEqual(0);
    expect(gross).toBeLessThanOrEqual(perfect + 1e-9);
  });

  it('a useless signal (same likelihoods for every outcome) is worth 0', () => {
    const useless = [
      { label: 'Heads', likelihoods: [0.5, 0.5] },
      { label: 'Tails', likelihoods: [0.5, 0.5] },
    ];
    expect(evii(OUTCOMES, ACTIONS, useless).evii).toBeCloseTo(0, 9);
  });

  it('a perfect signal recovers EVPI exactly', () => {
    const perfectSignals = [
      { label: 'Says success', likelihoods: [1, 0] },
      { label: 'Says dry', likelihoods: [0, 1] },
    ];
    const { evii: gross } = evii(OUTCOMES, ACTIONS, perfectSignals);
    expect(gross).toBeCloseTo(evpi(OUTCOMES, ACTIONS).evpi, 9);
  });

  it('rejects likelihood columns that do not sum to 1', () => {
    expect(() => evii(OUTCOMES, ACTIONS, [
      { label: 'a', likelihoods: [0.8, 0.3] },
      { label: 'b', likelihoods: [0.1, 0.7] },
    ])).toThrow(DecisionTreeError);
  });
});

describe('Suite port: buildInformationTree agrees with the closed-form formulas', () => {
  it('rollback of the built tree = max(net info value branch, prior branch)', () => {
    const tree = buildInformationTree({ outcomes: OUTCOMES, actions: ACTIONS, signals: SIGNALS, infoCost: 5 });
    const r = rollback(tree);
    expect(r.emv).toBeCloseTo(50.5, 9);
    expect(r.bestBranchIndex).toBe(0);
    expect(r.branches[0].node.branches[0].probability).toBeCloseTo(0.45, 9);
    expect(r.branches[1].branchValue).toBeCloseTo(43, 9);
    const { emvPrior, netEvii } = evii(OUTCOMES, ACTIONS, SIGNALS, 5);
    expect(r.emv).toBeCloseTo(emvPrior + netEvii, 9);
  });

  it('keeps the no-information branch optimal when info costs too much', () => {
    const tree = buildInformationTree({ outcomes: OUTCOMES, actions: ACTIONS, signals: SIGNALS, infoCost: 20 });
    const r = rollback(tree);
    expect(r.emv).toBeCloseTo(43, 9);
    expect(r.bestBranchIndex).toBe(1);
  });
});

describe('Suite port: impliedPriors (Bayes-consistency check for legacy VOI inputs)', () => {
  it('accepts a consistent set (derived from the Bayes case)', () => {
    const indicators = [
      { label: 'Positive', probability: 0.45, posteriors: [8 / 15, 7 / 15] },
      { label: 'Negative', probability: 0.55, posteriors: [6 / 55, 49 / 55] },
    ];
    const r = impliedPriors(OUTCOMES, indicators);
    expect(r.implied[0]).toBeCloseTo(0.3, 9);
    expect(r.implied[1]).toBeCloseTo(0.7, 9);
    expect(r.consistent).toBe(true);
  });

  it('flags an inconsistent set and reports the implied priors', () => {
    const indicators = [
      { label: 'Positive', probability: 0.45, posteriors: [0.8, 0.2] },
      { label: 'Negative', probability: 0.55, posteriors: [6 / 55, 49 / 55] },
    ];
    const r = impliedPriors(OUTCOMES, indicators);
    expect(r.consistent).toBe(false);
    expect(r.implied[0]).toBeCloseTo(0.45 * 0.8 + 0.55 * (6 / 55), 9);
  });
});

describe('Suite port: bestActionEmv', () => {
  it('returns the argmax action', () => {
    const r = bestActionEmv(OUTCOMES, ACTIONS);
    expect(r.emv).toBeCloseTo(43, 9);
    expect(r.actionIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (c) The Suite's voiCalculations.test.js, ported.
// ---------------------------------------------------------------------------

const DEFAULT_INPUTS = {
  projectName: 'Test Prospect',
  decisionName: 'Drill Exploration Well',
  decisionCost: 40,
  outcomes: [
    { id: 1, name: 'Success Case', probability: 30, payoff: 300 },
    { id: 2, name: 'Dry Hole', probability: 70, payoff: -50 },
  ],
  infoScenario: {
    name: '3D Seismic Survey',
    cost: 10,
    indicators: [
      { id: 1, name: 'Positive Seismic', probability: 40, conditionalProbabilities: [{ outcomeId: 1, probability: 60 }, { outcomeId: 2, probability: 40 }] },
      { id: 2, name: 'Negative Seismic', probability: 60, conditionalProbabilities: [{ outcomeId: 1, probability: 10 }, { outcomeId: 2, probability: 90 }] },
    ],
  },
};

describe('Suite port: generateVoiData (delegating to the canonical decision engine)', () => {
  const result = generateVoiData(DEFAULT_INPUTS);

  it('matches the hand-derived KPIs', () => {
    expect(Number(result.kpis.emvWithoutInfo)).toBeCloseTo(15, 2);
    expect(Number(result.kpis.emvWithInfo)).toBeCloseTo(38, 2);
    expect(Number(result.kpis.voi)).toBeCloseTo(33, 2);
    expect(Number(result.kpis.netVoi)).toBeCloseTo(23, 2);
    expect(Number(result.kpis.evpi)).toBeCloseTo(63, 2);
  });

  it('reports the default inputs as Bayes-consistent, with no warning', () => {
    expect(result.consistency.consistent).toBe(true);
    expect(result.insights).not.toContain('Consistency warning');
    expect(result.insights).toContain('positive');
  });

  it('states the negative verdict when info costs exceed its value', () => {
    const pricey = { ...DEFAULT_INPUTS, infoScenario: { ...DEFAULT_INPUTS.infoScenario, cost: 50 } };
    const r = generateVoiData(pricey);
    expect(Number(r.kpis.netVoi)).toBeCloseTo(-17, 2);
    expect(r.insights).toContain('not justified');
  });

  it('withholds the value of information when indicator entries contradict the stated priors (EC4-0)', () => {
    const inconsistent = JSON.parse(JSON.stringify(DEFAULT_INPUTS));
    inconsistent.infoScenario.indicators[0].conditionalProbabilities[0].probability = 90;
    inconsistent.infoScenario.indicators[0].conditionalProbabilities[1].probability = 10;
    const r = generateVoiData(inconsistent);
    expect(r.consistency.consistent).toBe(false);
    expect(r.withheld).toBe(true);
    expect(r.insights).toContain('Consistency warning');
    expect(r.insights).toContain('is withheld');
    // It survived AND it said so: the withheld cards are null, not a number.
    expect(r.kpis.voi).toBeNull();
    expect(r.kpis.netVoi).toBeNull();
    expect(r.kpis.emvWithInfo).toBeNull();
    expect(Number(r.kpis.emvWithoutInfo)).toBeCloseTo(15, 2);
    expect(Number(r.kpis.evpi)).toBeCloseTo(63, 2);
    expect(r.insights).not.toContain('Since this is');
  });

  describe('the decision tree behind the diagram', () => {
    it('is built and rolled back by the canonical engine', () => {
      expect(result.tree).toBeTruthy();
      expect(result.tree.type).toBe('decision');
      expect(result.tree.branches).toHaveLength(2);
    });

    it('values the acquire branch at exactly the reported EMV with information', () => {
      const acquire = result.tree.branches[0];
      expect(acquire.label).toMatch(/Acquire/);
      expect(acquire.branchValue).toBeCloseTo(Number(result.kpis.emvWithInfo), 8);
    });

    it('values the no-information branch at exactly the reported EMV without information', () => {
      const noInfo = result.tree.branches[1];
      expect(noInfo.branchValue).toBeCloseTo(Number(result.kpis.emvWithoutInfo), 8);
    });

    it('reproduces the indicator chances the user entered, not a re-derived set', () => {
      const signalNode = result.tree.branches[0].node;
      expect(signalNode.type).toBe('chance');
      const chances = signalNode.branches.map((b) => b.probability);
      expect(chances[0]).toBeCloseTo(0.4, 10);
      expect(chances[1]).toBeCloseTo(0.6, 10);
    });

    it('is not drawn when posteriors contradict the priors (EC4-0: withheld with the cards)', () => {
      const contradicting = JSON.parse(JSON.stringify(DEFAULT_INPUTS));
      contradicting.infoScenario.indicators[0].conditionalProbabilities[0].probability = 90;
      contradicting.infoScenario.indicators[0].conditionalProbabilities[1].probability = 10;
      const r = generateVoiData(contradicting);
      expect(r.consistency.consistent).toBe(false);
      expect(r.tree).toBeNull();
    });

    it("refuses, in percent, an indicator whose outcome chances do not sum to 100 (EC4-0)", () => {
      const malformed = JSON.parse(JSON.stringify(DEFAULT_INPUTS));
      malformed.infoScenario.indicators[0].conditionalProbabilities[0].probability = 90;
      expect(() => generateVoiData(malformed)).toThrow(DecisionTreeError);
      expect(() => generateVoiData(malformed)).toThrow('Outcome chances given "Positive Seismic" sum to 130 percent, expected 100');
    });
  });
});

// ---------------------------------------------------------------------------
// (b) Golden agreement gates.
// ---------------------------------------------------------------------------

describe('golden: rollback', () => {
  expect(G.rollback.length).toBeGreaterThanOrEqual(12);
  for (const c of G.rollback) {
    it(`${c.id}: ${c.description}`, () => {
      expectTree(rollback(c.tree), c.expected, c.id);
    });
  }
});

describe('golden: rollback refusals', () => {
  for (const c of G.rollbackRefusals) {
    it(`${c.id}: refused (${c.reason})`, () => {
      expect(() => rollback(c.tree)).toThrow(DecisionTreeError);
    });
  }
});

describe('golden: EVPI', () => {
  for (const c of G.evpi) {
    it(`${c.id}: ${c.description}`, () => {
      const r = evpi(c.outcomes, c.actions);
      near(r.emvPrior, c.expected.emvPrior, ABS, `${c.id} emvPrior`);
      near(r.evWithPerfect, c.expected.evWithPerfect, ABS, `${c.id} evWithPerfect`);
      near(r.evpi, c.expected.evpi, ABS, `${c.id} evpi`);
      expect(r.evpi).toBeGreaterThanOrEqual(-ABS);
      const b = bestActionEmv(c.outcomes, c.actions);
      near(b.emv, c.expected.emvPrior, ABS, `${c.id} bestActionEmv`);
      expect(b.actionIndex).toBe(c.expected.bestActionIndex);
    });
  }
});

describe('golden: EVII through Bayes', () => {
  for (const c of G.evii) {
    it(`${c.id}: ${c.description}`, () => {
      const r = evii(c.outcomes, c.actions, c.signals, c.infoCost);
      const e = c.expected;
      near(r.emvPrior, e.emvPrior, ABS, `${c.id} emvPrior`);
      near(r.evWithInfo, e.evWithInfo, ABS, `${c.id} evWithInfo`);
      near(r.evii, e.evii, ABS, `${c.id} evii`);
      near(r.netEvii, e.netEvii, ABS, `${c.id} netEvii`);
      expect(r.perSignal).toHaveLength(e.perSignal.length);
      e.perSignal.forEach((s, k) => {
        near(r.perSignal[k].pSignal, s.pSignal, ABS, `${c.id} signal ${k} pSignal`);
        near(r.perSignal[k].emv, s.emv, ABS, `${c.id} signal ${k} emv`);
        expect(r.perSignal[k].bestActionIndex).toBe(s.bestActionIndex);
        expect(r.perSignal[k].posterior).toHaveLength(s.posterior.length);
        s.posterior.forEach((p, i) => near(r.perSignal[k].posterior[i], p, ABS, `${c.id} signal ${k} posterior ${i}`));
        expect(r.perSignal[k].label).toBe(c.signals[k].label);
      });
      // (a) identities on every case.
      const perfect = evpi(c.outcomes, c.actions).evpi;
      near(perfect, e.evpi, ABS, `${c.id} evpi`);
      expect(r.evii).toBeGreaterThanOrEqual(-ABS);
      expect(r.evii).toBeLessThanOrEqual(perfect + ABS);
    });
  }

  it('(a) EVII rises monotonically with signal accuracy and reaches EVPI at accuracy 1', () => {
    const sweep = G.evii.filter((c) => c.accuracy !== undefined).sort((x, y) => x.accuracy - y.accuracy);
    expect(sweep.length).toBe(11);
    let last = -Infinity;
    for (const c of sweep) {
      const v = evii(c.outcomes, c.actions, c.signals).evii;
      expect(v).toBeGreaterThanOrEqual(last - ABS);
      last = v;
    }
    near(evii(sweep[0].outcomes, sweep[0].actions, sweep[0].signals).evii, 0, ABS, 'accuracy 0.5');
    near(last, evpi(sweep[0].outcomes, sweep[0].actions).evpi, ABS, 'accuracy 1');
  });
});

describe('golden: EVII refusals', () => {
  for (const c of G.eviiRefusals) {
    it(`${c.id}: refused (${c.reason})`, () => {
      expect(() => evii(c.outcomes, c.actions, c.signals)).toThrow(DecisionTreeError);
    });
  }
});

describe('golden: implied priors', () => {
  for (const c of G.impliedPriors) {
    it(`${c.id}: ${c.description}`, () => {
      const r = impliedPriors(c.outcomes, c.indicators);
      const e = c.expected;
      e.stated.forEach((v, i) => near(r.stated[i], v, ABS, `${c.id} stated ${i}`));
      e.implied.forEach((v, i) => near(r.implied[i], v, ABS, `${c.id} implied ${i}`));
      e.deltas.forEach((v, i) => near(r.deltas[i], v, ABS, `${c.id} delta ${i}`));
      expect(c.disagreement).toBeUndefined();
      expect(r.consistent).toBe(e.consistent);
      if (c.id === 'justInsideTolerance') {
        // Finding D1, resolved in EC4-0: the float delta still sits 4.4e-18
        // above 0.005, and the engine now calls it consistent as the method
        // does. Negative control: without the allowance it would not be.
        expect(r.deltas[0] - 0.005).toBeGreaterThan(0);
        expect(r.deltas[0] - 0.005).toBeLessThan(1e-17);
        expect(r.deltas.every((d) => Math.abs(d) <= 0.005)).toBe(false);
      }
    });
  }
});

describe('golden: information tree', () => {
  for (const c of G.informationTree) {
    it(`${c.id}: ${c.description}`, () => {
      const tree = buildInformationTree({
        outcomes: c.outcomes, actions: c.actions, signals: c.signals,
        infoCost: c.infoCost, infoLabel: c.infoLabel,
      });
      const r = rollback(tree);
      expectTree(r, c.expected, c.id);
      const e = c.expected;
      if (e.closedForm) {
        expect(r.branches[0].label).toBe(c.infoLabel);
        e.signalMarginals.forEach((m, s) => near(r.branches[0].node.branches[s].probability, m, ABS, `${c.id} marginal ${s}`));
        near(r.branches[0].branchValue, e.acquireBranchValue, ABS, `${c.id} acquire branch`);
        near(r.branches[1].branchValue, e.noInfoBranchValue, ABS, `${c.id} no-info branch`);
        // (a) the tree reproduces the closed forms.
        const cf = evii(c.outcomes, c.actions, c.signals, c.infoCost);
        near(r.branches[1].branchValue, cf.emvPrior, ABS, `${c.id} prior identity`);
        near(r.branches[0].branchValue, cf.evWithInfo - c.infoCost, ABS, `${c.id} info identity`);
        near(r.emv, Math.max(cf.evWithInfo - c.infoCost, cf.emvPrior), ABS, `${c.id} root identity`);
        near(cf.evpi === undefined ? evpi(c.outcomes, c.actions).evpi : cf.evpi, e.closedForm.evpi, ABS, `${c.id} evpi`);
      }
    });
  }
});

describe('golden: VOI Analyzer', () => {
  const VERDICT_TEXT = {
    acquire: 'Since this is positive',
    reject: 'not justified',
    neutral: 'Since this rounds to zero, the information costs what it is worth',
  };
  for (const c of G.voi) {
    it(`${c.id}: ${c.description}`, () => {
      const r = generateVoiData(c.inputs);
      const e = c.expected;
      expect(r.withheld).toBe(e.withheld);
      for (const k of ['emvWithoutInfo', 'emvWithInfo', 'voi', 'netVoi', 'evpi']) {
        if (e[k] === null) {
          expect(r.kpis[k]).toBeNull();
          continue;
        }
        expect(r.kpis[k]).toMatch(/^-?\d+\.\d{2}$/);
        near(Number(r.kpis[k]), e[k], KPI, `${c.id} kpi ${k}`);
        // EC4-2: the card string is exactly the oracle's rounding, never -0.00.
        expect(r.kpis[k]).toBe(e.cards[k]);
        expect(r.kpis[k]).not.toBe('-0.00');
      }
      expect(r.insights).not.toContain('-0.00');
      expect(r.insights).toContain(`'${e.optimalActionWithoutInfo}'`);
      if (e.verdict === null) {
        for (const t of Object.values(VERDICT_TEXT)) expect(r.insights).not.toContain(t);
        expect(r.insights).toContain('is withheld');
      } else {
        expect(r.insights).toContain(VERDICT_TEXT[e.verdict]);
        for (const [v, t] of Object.entries(VERDICT_TEXT)) if (v !== e.verdict) expect(r.insights).not.toContain(t);
        // EC4-2: one rounded net VOI feeds the card and the verdict.
        const card = Number(r.kpis.netVoi);
        expect(e.verdict).toBe(card > 0 ? 'acquire' : card < 0 ? 'reject' : 'neutral');
        expect(r.insights).toContain(`the Net VOI is $${r.kpis.netVoi}M.`);
      }
      expect(r.consistency.consistent).toBe(e.consistency.consistent);
      e.consistency.implied.forEach((v, i) => near(r.consistency.implied[i], v, ABS, `${c.id} implied ${i}`));
      e.consistency.deltas.forEach((v, i) => near(r.consistency.deltas[i], v, ABS, `${c.id} delta ${i}`));
      if (e.consistency.consistent) expect(r.insights).not.toContain('Consistency warning');
      else expect(r.insights).toContain('Consistency warning');
      // (a) withheld exactly when inconsistent, and only then without a tree.
      expect(e.withheld).toBe(!e.consistency.consistent);
      if (!e.treePresent) {
        expect(e.withheld).toBe(true);
        expect(r.tree).toBeNull();
        return;
      }
      expect(r.tree).toBeTruthy();
      expectTree(r.tree, e.tree, `${c.id} tree`);
      e.signalChances.forEach((p, s) => near(r.tree.branches[0].node.branches[s].probability, p, ABS, `${c.id} chance ${s}`));
      near(r.tree.branches[0].branchValue, e.acquireBranchValue, ABS, `${c.id} acquire branch`);
      near(r.tree.branches[1].branchValue, e.noInfoBranchValue, ABS, `${c.id} no-info branch`);
      // (a) the picture and the KPI card are one analysis: unrounded.
      near(r.tree.branches[0].branchValue, e.emvWithInfo, ABS, `${c.id} tree = emvWithInfo`);
      near(r.tree.branches[1].branchValue, e.emvWithoutInfo, ABS, `${c.id} tree = emvWithoutInfo`);
    });
  }

  it('(a) VOI rises monotonically with indicator accuracy from 0 to EVPI', () => {
    const sweep = G.voi.filter((c) => c.accuracy !== undefined).sort((x, y) => x.accuracy - y.accuracy);
    expect(sweep.length).toBe(11);
    let last = -Infinity;
    for (const c of sweep) {
      const r = generateVoiData(c.inputs);
      const v = r.tree.branches[0].branchValue + c.inputs.infoScenario.cost - r.tree.branches[1].branchValue;
      expect(v).toBeGreaterThanOrEqual(last - ABS);
      last = v;
    }
    const first = generateVoiData(sweep[0].inputs);
    near(first.tree.branches[0].branchValue + sweep[0].inputs.infoScenario.cost - first.tree.branches[1].branchValue, 0, ABS, 'accuracy 0.5');
    near(last, Number(generateVoiData(sweep[0].inputs).kpis.evpi), KPI, 'accuracy 1 = EVPI');
  });
});

describe('golden: VOI Analyzer refusals (EC4-0)', () => {
  expect(G.voiRefusals.length).toBeGreaterThanOrEqual(7);
  for (const c of G.voiRefusals) {
    it(`${c.id}: refused (${c.reason})`, () => {
      expect(() => generateVoiData(c.inputs)).toThrow(DecisionTreeError);
      let message = '';
      try { generateVoiData(c.inputs); } catch (err) { message = err.message; }
      if (c.sumPercent !== undefined) {
        // The refusal names the sum IN PERCENT, the scale the form types.
        expect(message).toContain(`sum to ${Number(c.sumPercent.toFixed(4))} percent, expected 100`);
      } else {
        expect(message).toMatch(/between 0 and 100 percent|No indicators given|No outcomes given/);
      }
    });
  }
});

describe('golden: shape', () => {
  it('carries a description and every section', () => {
    expect(typeof G.description).toBe('string');
    for (const k of ['rollback', 'rollbackRefusals', 'evpi', 'evii', 'eviiRefusals', 'impliedPriors', 'informationTree', 'voi', 'voiRefusals']) {
      expect(Array.isArray(G[k])).toBe(true);
      expect(G[k].length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// EC4-8 and EC4-2 (owner decisions 2026-09-15): the retired rules, restored
// here as NEGATIVE CONTROLS, must disagree with the goldens they were retired
// for, and the new rules must still refuse what is genuinely off.
// ---------------------------------------------------------------------------

const byId = (section, id) => {
  const c = G[section].find((x) => x.id === id);
  if (!c) throw new Error(`golden ${section}/${id} missing`);
  return c;
};

describe('EC4-8: binary representation allowance on every probability tolerance', () => {
  // The retired comparisons, exactly as they were.
  const oldProbRefuses = (sum) => Math.abs(sum - 1) > 1e-6;
  const oldPctRefuses = (sum) => Math.abs(sum - 100) > 1e-4;
  const sum = (xs) => xs.reduce((s, x) => s + x, 0);

  it('rollback accepts thirds typed to six places; the old strict rule refused them', () => {
    const c = byId('rollback', 'thirdsTypedToSixPlaces');
    const ps = c.tree.branches.map((b) => b.probability);
    expect(oldProbRefuses(sum(ps))).toBe(true); // negative control
    expect(Math.abs(sum(ps) - 1) - 1e-6).toBeLessThan(1e-12);
    expectTree(rollback(c.tree), c.expected, c.id);
    near(rollback(c.tree).emv, 34.999965, ABS, 'typed thirds are not renormalised');
  });

  it('EVPI accepts priors typed to six places; the old strict rule refused them', () => {
    const c = byId('evpi', 'thirdsPriorsSixPlaces');
    expect(oldProbRefuses(sum(c.outcomes.map((o) => o.probability)))).toBe(true);
    expect(() => evpi(c.outcomes, c.actions)).not.toThrow();
  });

  it('EVII accepts a likelihood column typed to six places; the old strict rule refused it', () => {
    const c = byId('evii', 'likelihoodColumnSixPlaces');
    expect(oldProbRefuses(sum(c.signals.map((sg) => sg.likelihoods[0])))).toBe(true);
    expect(() => evii(c.outcomes, c.actions, c.signals, c.infoCost)).not.toThrow();
  });

  it('the VOI Analyzer accepts outcome chances typed 33.3333; the old strict rule refused them', () => {
    const c = byId('voi', 'thirdsOutcomeChancesFourPlaces');
    expect(oldPctRefuses(sum(c.inputs.outcomes.map((o) => o.probability)))).toBe(true);
    const r = generateVoiData(c.inputs);
    expect(r.withheld).toBe(false);
    expect(r.tree).toBeTruthy();
  });

  it('a sum genuinely off by more than the tolerance is still refused, at every site', () => {
    expect(() => rollback(byId('rollbackRefusals', 'sumShortByTwoMillionths').tree)).toThrow('sum to 0.999998, expected 1');
    expect(() => rollback(byId('rollbackRefusals', 'thirdsTypedToThreePlaces').tree)).toThrow('sum to 0.999000, expected 1');
    const col = byId('eviiRefusals', 'likelihoodColumnShortByTwoMillionths');
    expect(() => evii(col.outcomes, col.actions, col.signals)).toThrow('sum to 0.999998, expected 1');
    const pri = byId('eviiRefusals', 'priorsShortByTwoMillionths');
    expect(() => evii(pri.outcomes, pri.actions, pri.signals)).toThrow('Outcome probabilities sum to 0.999998, expected 1');
    expect(() => generateVoiData(byId('voiRefusals', 'outcomeChancesShortByTwoTenThousandths').inputs))
      .toThrow('Outcome chances sum to 99.9998 percent, expected 100');
    expect(() => generateVoiData(byId('voiRefusals', 'thirdsOutcomeChancesThreePlaces').inputs))
      .toThrow('Outcome chances sum to 99.999 percent, expected 100');
  });
});

describe('EC4-2: one rounded net VOI for the card and the verdict', () => {
  // The retired rules: verdict from the UNROUNDED net, card from toFixed(2).
  const oldVerdict = (net) => (net > 0 ? 'acquire' : net < 0 ? 'reject' : 'neutral');
  const unroundedNet = (r) => r.tree.branches[0].branchValue - r.tree.branches[1].branchValue;

  it('cost 32.996: card 0.00 and neutral; the old unrounded verdict said acquire under that card', () => {
    const c = byId('voi', 'netRoundsToZeroFromAbove');
    const r = generateVoiData(c.inputs);
    expect(r.kpis.netVoi).toBe('0.00');
    expect(c.expected.verdict).toBe('neutral');
    expect(r.insights).toContain('Since this rounds to zero');
    expect(oldVerdict(unroundedNet(r))).toBe('acquire'); // negative control
  });

  it('cost 33.004: card 0.00 and neutral; the old card printed -0.00 under a reject verdict', () => {
    const c = byId('voi', 'netRoundsToZeroFromBelow');
    const r = generateVoiData(c.inputs);
    expect(r.kpis.netVoi).toBe('0.00');
    expect(c.expected.verdict).toBe('neutral');
    expect(unroundedNet(r).toFixed(2)).toBe('-0.00'); // negative control
    expect(oldVerdict(unroundedNet(r))).toBe('reject'); // negative control
  });

  it('cost 33: exactly zero is neutral under both rules', () => {
    const r = generateVoiData(byId('voi', 'costExactlyValue').inputs);
    expect(r.kpis.netVoi).toBe('0.00');
    expect(r.insights).toContain('Since this rounds to zero');
  });

  it('half-cent boundaries round away from zero, and clear cases keep their verdicts', () => {
    const expectations = {
      netHalfCentAbove: ['0.01', 'Since this is positive'],
      netHalfCentBelow: ['-0.01', 'not justified'],
      netClearlyPositive: ['0.10', 'Since this is positive'],
      netClearlyNegative: ['-0.10', 'not justified'],
    };
    for (const [id, [cardText, verdictText]] of Object.entries(expectations)) {
      const r = generateVoiData(byId('voi', id).inputs);
      expect(r.kpis.netVoi).toBe(cardText);
      expect(r.insights).toContain(verdictText);
      expect(byId('voi', id).expected.cards.netVoi).toBe(cardText);
    }
  });
});

describe('EC4-9: derived branch probabilities are renormalised once typed inputs pass', () => {
  // Stated tolerance: a case typed to four places agrees with its exact
  // thirds reference within 1e-3 $MM on every unrounded quantity. The typed
  // stated chances (0.333333, used as typed) differ from 1/3 by 3.3e-7, and
  // payoffs of a few hundred $MM carry that to about 1e-4.
  const EDGE_TOL = 1e-3;
  const pairs = [
    ['compoundEdgeAllThirds', 'compoundEdgeAllThirdsExact'],
    ['compoundEdgeInformative', 'compoundEdgeInformativeExact'],
  ];

  // The retired derivation, restored: the typed chances inverted by Bayes
  // with no renormalisation, exactly as voi.js built the diagram before.
  const oldDiagram = (inputs) => {
    const priors = inputs.outcomes.map((o) => o.probability / 100);
    const outcomes = inputs.outcomes.map((o) => ({ label: o.name, probability: o.probability / 100 }));
    const actions = [
      { label: inputs.decisionName, cost: inputs.decisionCost, payoffs: inputs.outcomes.map((o) => o.payoff) },
      { label: `Do Not ${inputs.decisionName}`, cost: 0, payoffs: inputs.outcomes.map(() => 0) },
    ];
    const signals = inputs.infoScenario.indicators.map((ind) => {
      const post = inputs.outcomes.map((o) => ind.conditionalProbabilities.find((c) => c.outcomeId === o.id).probability / 100);
      return { label: ind.name, likelihoods: priors.map((p, i) => (p > 0 ? (post[i] * ind.probability / 100) / p : 0)) };
    });
    return rollback(buildInformationTree({
      outcomes, actions, signals, infoCost: inputs.infoScenario.cost, infoLabel: `Acquire ${inputs.infoScenario.name}`,
    }));
  };

  for (const [edgeId, exactId] of pairs) {
    it(`${edgeId}: full cards and diagram, within ${EDGE_TOL} $MM of ${exactId}`, () => {
      const edge = byId('voi', edgeId);
      const exact = byId('voi', exactId);
      const r = generateVoiData(edge.inputs);
      expect(r.withheld).toBe(false);
      expect(r.tree).toBeTruthy();
      const signalNode = r.tree.branches[0].node;
      expect(signalNode.label).toBe('Signal received');
      near(signalNode.branches.reduce((s, b) => s + b.probability, 0), 1, 1e-12, `${edgeId} renormalised signal chances`);
      for (const k of ['emvWithoutInfo', 'emvWithInfo', 'voi', 'netVoi', 'evpi']) {
        near(edge.expected[k], exact.expected[k], EDGE_TOL, `${edgeId} vs ${exactId} ${k}`);
      }
      near(r.tree.branches[0].branchValue, exact.expected.emvWithInfo, EDGE_TOL, `${edgeId} diagram vs exact`);
      // The cards and the diagram are still one analysis, unrounded.
      near(r.tree.branches[0].branchValue, edge.expected.emvWithInfo, ABS, `${edgeId} tree = emvWithInfo`);
      // Negative control: the pre-EC4-9 derivation refuses at "Signal received".
      expect(() => oldDiagram(edge.inputs)).toThrow(DecisionTreeError);
      expect(() => oldDiagram(edge.inputs)).toThrow('sum to 0.999998, expected 1 (at node "Signal received")');
      // And it is the compound edge that trips it: the exact reference builds.
      expect(() => oldDiagram(exact.inputs)).not.toThrow();
    });
  }

  it('the strict chance node check still refuses a node typed directly', () => {
    expect(() => rollback({
      type: 'chance', label: 'typed', branches: [
        { label: 'a', probability: 0.333333, node: { type: 'terminal', payoff: 1 } },
        { label: 'b', probability: 0.333333, node: { type: 'terminal', payoff: 1 } },
        { label: 'c', probability: 0.333332, node: { type: 'terminal', payoff: 1 } },
      ],
    })).toThrow('Chance branch probabilities sum to 0.999998, expected 1 (at node "typed")');
  });
});
