#!/usr/bin/env python3
"""Write test-data/wellsite/*.json from the oracles (byte-identical regeneration)."""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import oracle_ws0

ROOT = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'test-data', 'wellsite')

def write(name, obj):
    path = os.path.join(ROOT, name)
    with open(path, 'w') as f:
        json.dump(obj, f, indent=2, sort_keys=True)
        f.write('\n')
    print('wrote', os.path.relpath(path))

if __name__ == '__main__':
    os.makedirs(ROOT, exist_ok=True)
    write('ws0-goldens.json', oracle_ws0.build())
