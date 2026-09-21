// FC1-0 D7: gasDensityLbFt3 refuses a DAK solve that did not converge.
//
// Inside the validity range the production Newton solver converges on
// every case this repo has probed, so the refusal cannot be reached by
// choosing inputs. The gate replaces dakZ with one that reports
// converged: false and checks the density is refused rather than built
// from the unconverged z (which the retired code did).

jest.mock('../engines/production/gasProperties.js', () => {
  const actual = jest.requireActual('../engines/production/gasProperties.js');
  return {
    ...actual,
    dakZ: (args) => ({ ...actual.dakZ(args), converged: false }),
  };
});

// eslint-disable-next-line import/first
import { gasDensityLbFt3 } from '../engines/facilities/separatorSizing';

test('D7 NEGATIVE CONTROL: an unconverged z is refused, not used', () => {
  const r = gasDensityLbFt3({ pPsia: 1000, tF: 100, gasSg: 0.65 });
  expect(r.error).toBe('the DAK z-factor did not converge at these conditions');
  expect(r.rhoLbFt3).toBeUndefined();
  expect(r.z).toBeUndefined();
});
