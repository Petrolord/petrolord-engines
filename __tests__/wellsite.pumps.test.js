/** Wellsite WS0 pump displacement against the stdlib oracle goldens. */
import g from '../test-data/wellsite/ws0-goldens.json';
import { pumpDisplacement, displacementFromField, flowRate, strokesForVolume } from '../engines/wellsite/pumps';

const near = (a, b, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(tol);

test('6 x 12 in triplex at 97 percent', () => {
  const r = displacementFromField({ linerIn: 6, strokeIn: 12, efficiency: 0.97 });
  const e = g.pumps.triplex_6x12_97;
  near(r.theoreticalM3PerStroke, e.theoreticalM3PerStroke);
  near(r.m3PerStroke, e.m3PerStroke);
  near(r.bblPerStroke, e.bblPerStroke);
  expect(r.cylinders).toBe(3);
  // the field constant 0.000243 is the same geometry rounded: within 0.1 percent
  expect(Math.abs(r.bblPerStroke - e.fieldBblPerStroke) / e.bblPerStroke).toBeLessThan(0.001);
});

test('7.25 x 14 in duplex with a 2.5 in rod at 90 percent', () => {
  const r = displacementFromField({ type: 'duplex', linerIn: 7.25, strokeIn: 14, rodIn: 2.5, efficiency: 0.9 });
  const e = g.pumps.duplex_7p25x14_rod2p5_90;
  near(r.m3PerStroke, e.m3PerStroke);
  near(r.bblPerStroke, e.bblPerStroke);
  expect(r.cylinders).toBe(2);
  expect(Math.abs(r.bblPerStroke - e.fieldBblPerStroke) / e.bblPerStroke).toBeLessThan(0.001);
});

test('flow and strokes follow from the displacement', () => {
  const { m3PerStroke } = g.pumps.triplex_6x12_97;
  const f = flowRate({ m3PerStroke, spm: 60 });
  near(f.m3PerMin, m3PerStroke * 60);
  near(f.lPerMin, m3PerStroke * 60000);
  near(strokesForVolume(193.152, m3PerStroke), 193.152 / m3PerStroke);
});

test('refusals', () => {
  expect(() => pumpDisplacement({ type: 'quad', linerIdM: 0.1, strokeLengthM: 0.3 })).toThrow('Pump type must be triplex or duplex.');
  expect(() => pumpDisplacement({ linerIdM: 0, strokeLengthM: 0.3 })).toThrow('Liner inside diameter must be positive.');
  expect(() => pumpDisplacement({ linerIdM: 0.1, strokeLengthM: 0.3, efficiency: 1.2 })).toThrow('Pump efficiency must be between 0 and 1.');
  expect(() => strokesForVolume(1, 0)).toThrow('Pump displacement must be positive.');
});
