"""Oracle for engines/qi/qcAdditions.js autocorrelation (QI upgrade P2.11).
numpy.correlate in full mode, normalised by the zero lag, on seeded traces.
Writes test-data/qi/goldens.qcAdditions.json."""
import json, os
import numpy as np


def main():
    rng = np.random.default_rng(1115)
    cases = []
    for k in range(4):
        x = rng.normal(0, 1, 300)
        full = np.correlate(x, x, mode='full')[len(x) - 1:]
        cases.append({'trace': [float(v) for v in x], 'acf': [float(v) for v in full[:81] / full[0]]})
    out = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'test-data', 'qi', 'goldens.qcAdditions.json')
    with open(out, 'w') as f:
        json.dump({'source': 'tools/validation/qi/oracle_qc_additions.py', 'cases': cases}, f)


if __name__ == '__main__':
    main()
