# Mapping T1 engine findings (2026-09-26)

Engine work for the Mapping & Surface Studio senior test T1
(Suite `docs/testing/MappingSurfaceStudio-T1.md`). Gates:
`__tests__/mapping.t1.test.js` (43 tests). Negative controls:
`negcontrol_t1.sh`, **30/30 engine plants red, 5/5 oracle plants caught**.

## What was added

| Module | Finding | What it does |
| --- | --- | --- |
| `lib/gridding/closure.js` | MAP-T1-001, -002, E1 | Closures above a contact (4-neighbour components, open when touching the map edge or a null node); spill by priority flood from the crest (bottleneck to the map boundary, edge-limited flag, fill-spill merges with neighbouring culminations above a relief threshold); closure at any contact and the area-depth / GRV-versus-contact curve as prefixes of one flood |
| `lib/gridding/gridding.js` `mergeCloseControls` | MAP-T1-003 | Single-linkage merge of control points within a distance (mean position and value, wells named, spread reported) |
| `lib/gridding/gridding.js` `mask: 'none'` | MAP-T1-007 | TPS evaluated on every node of the frame, so the map can extend past the outermost wells |
| `lib/gridding/tensionSpline.js` | MAP-T1-008 | Green's-function spline in tension with smoothing (Wessel & Bercovici 1998; Mitasova & Mitas 1993) |
| `engines/mapping/wellTie.js` | MAP-T1-009 | Average velocity at wells from TWT and top depth, depth from an average-velocity grid, tie residuals and their statistics |

## Decisions and corrections

1. **TPS already is minimum curvature.** Sandwell (1987) shows Briggs'
   minimum-curvature grid is the discretisation of the biharmonic spline,
   which is the thin-plate spline the Studio grids with. The T1 finding
   "no minimum-curvature gridding" is corrected to "no tension and no
   smoothing". A discrete Briggs solver was built first and dropped: its
   matrix-free CG either stopped early (a relative residual of 1e-9 left
   0.6 m errors far from the data) or took 37 s to 2.5 min on 241 to 401
   node grids at a tolerance that made it accurate. The Green's-function
   spline has no convergence question and costs what TPS costs (700
   controls on 401 x 401 in 0.7 s in Node).
2. **Low-tension precision.** K0(x) + ln x cancels as x -> 0 and the spline
   shape lives in the O(x^2 ln x) remainder, so a K0 polynomial with 1e-7
   absolute error swamps it. Both the engine and the oracle use the
   ascending series written as a sum of positive terms below x = 2 (the
   oracle below 0.5, with the integral above, asserted equal on [0.5, 2]).
   Found by the oracle's thin-plate-limit anchor.
3. **Smoothing sign.** r^2 ln r is conditionally positive definite; the
   tension kernel enters with the opposite sign, so the smoothing diagonal
   is +s for the biharmonic kernel and -s for the tension kernel. With +s
   on the tension kernel the misfit jumped to 245 m at s = 0.1 and was not
   monotone; the gate asserts monotone growth.
4. **Tension does not keep planes in a discrete membrane**, but the
   Green's-function form carries planes in its affine part, so a plane is
   exact at any tension (asserted, 1e-9).
5. **Spill definition.** The spill is the bottleneck between the crest and
   the MAP BOUNDARY. A saddle into a neighbouring culmination is reported
   separately as a merge (fill-spill): filled below it, the two are one
   accumulation, and the combined closure is the connected component the
   GRV counts. The first oracle draft expected the saddle as the spill and
   was corrected; both implementations agree.
6. **Ties.** On symmetric grids many nodes share the saddle elevation. The
   saddle reported is the node through which the flood entered the next
   culmination (the pusher of the first climbing node), and the spill node
   the lowest node on the flood path from crest to exit; a closure is
   edge-limited when the exit node itself sits at the bottleneck level.
7. **Dead code removed.** A filter meant to drop a merge at the spill level
   never fired: such an event is never closed (events close only when the
   running minimum drops). The plant on it stayed green, which is how it
   was found; the `spill_into_cut_dome` case now pins the behaviour.

## Sources

- Briggs, I. C. (1974). Machine contouring using minimum curvature. Geophysics 39(1), 39-48.
- Sandwell, D. T. (1987). Biharmonic spline interpolation of GEOS-3 and SEASAT altimeter data. GRL 14(2), 139-142.
- Smith, W. H. F. & Wessel, P. (1990). Gridding with continuous curvature splines in tension. Geophysics 55(3), 293-305.
- Wessel, P. & Bercovici, D. (1998). Interpolation with splines in tension: a Green's function approach. Math. Geology 30(1), 77-93.
- Mitasova, H. & Mitas, L. (1993). Interpolation by regularized spline with tension. Math. Geology 25(6), 641-655.
- Abramowitz, M. & Stegun, I. A. (1964). Handbook of Mathematical Functions, 9.6.13, 9.8.1, 9.8.5, 9.8.6, Table 9.8.
