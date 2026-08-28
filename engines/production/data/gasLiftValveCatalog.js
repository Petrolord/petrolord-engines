/**
 * Gas-lift valve geometry (Production P4).
 *
 * Bellows areas and port sizes for the two mandrel families the
 * industry standardised on: the 1 in OD valve (0.31 in2 bellows) and
 * the 1.5 in OD valve (0.77 in2 bellows). These two areas and the port
 * ladders below are the generic geometry every gas-lift text and the
 * API Gas Lift Manual work their examples in; the ratio R = Ap/Ab this
 * file yields reproduces the published R tables (1/8 in port in a 1 in
 * valve, R = 0.040; 1/4 in port in a 1.5 in valve, R = 0.064).
 *
 * It is deliberately NOT a vendor catalog. Individual manufacturers
 * publish their own effective bellows areas and their own R for each
 * port, and a real installation must be set from the vendor sheet for
 * the valve actually run. The spot-check of this generic geometry
 * against a vendor data book is an ARMED validation gate, not an
 * assertion this file makes.
 */

const PORTS_1IN = [
  { idIn: 1 / 8, label: '1/8 in' },
  { idIn: 5 / 32, label: '5/32 in' },
  { idIn: 3 / 16, label: '3/16 in' },
  { idIn: 7 / 32, label: '7/32 in' },
  { idIn: 1 / 4, label: '1/4 in' },
  { idIn: 5 / 16, label: '5/16 in' },
];

const PORTS_15IN = [
  { idIn: 1 / 4, label: '1/4 in' },
  { idIn: 5 / 16, label: '5/16 in' },
  { idIn: 3 / 8, label: '3/8 in' },
  { idIn: 7 / 16, label: '7/16 in' },
  { idIn: 1 / 2, label: '1/2 in' },
  { idIn: 5 / 8, label: '5/8 in' },
  { idIn: 3 / 4, label: '3/4 in' },
];

export const VALVE_FAMILIES = [
  {
    id: 'r1',
    label: '1 in OD valve',
    bellowsAreaIn2: 0.31,
    mandrelNote: 'Runs in a 1 in pocket side-pocket mandrel or a conventional 1 in mandrel.',
    ports: PORTS_1IN,
  },
  {
    id: 'r15',
    label: '1.5 in OD valve',
    bellowsAreaIn2: 0.77,
    mandrelNote: 'Runs in a 1.5 in pocket side-pocket mandrel; the usual choice above about 2 MMscf/d.',
    ports: PORTS_15IN,
  },
];

export const valveFamily = (id) => VALVE_FAMILIES.find((f) => f.id === id) || VALVE_FAMILIES[0];
