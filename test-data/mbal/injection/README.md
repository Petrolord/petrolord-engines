# MBAL injection oracle (MBAL-U2-002, 2026-10-02)

`oracle.py` is a stdlib-only Python oracle for the injection terms of the
material balance (F = Np[Bt + (Rp - Rsi)Bg] + Wp Bw - Winj Bw - Ginj Bginj;
Ahmed, Reservoir Engineering Handbook 4th ed., Ch. 11, general MBE). It shares
no code with `engines/mbal/mbalEngine.ts`. `injection-golden.json` is its
output (`python3 oracle.py > injection-golden.json`); `__tests__/mbalInjection.test.ts`
(GATE 11) asserts the engine against it.

Why an oracle and not a book example: no published worked example of a
material balance with injection could be read for this round. The textbook
examples that have one are not open; the open lecture notes found reproduce
Ahmed's equation without numbers. The gate therefore holds:

1. `ahmed_11_1_with_injection`: the published Ahmed Example 11-1 data
   (N = 10 MMSTB given) with 100,000 STB of water and 100 MMscf of gas
   injection ADDED. The oracle first reproduces the printed influx without
   injection (413,081 against 411,281 bbl printed; the book rounds Bt to
   1.655), then gives the net F, the back-calculated We and all six drive
   indices with injection.
2. `synthetic_oil_injection`: an undersaturated oil tank, N = 50 MMSTB,
   under water and gas injection, with the water injection solved from the
   MBE so the tank is exact. The engine must return N to round-off.
3. `synthetic_gas_cycling`: a gas tank, G = 100 Bscf, under gas cycling.

Each has a negative control in the gate: the same rows without the injection
columns, which is what the engine computed before 2026-10-02.

Assumption stated with the engine: the injected gas is the produced gas, so
Bginj is the Bg of the reservoir gas at each timestep pressure.
