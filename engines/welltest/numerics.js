// Shared numerical kernels for well test analysis.
//
// These already lived in lib/welltest before this extraction, because the
// Levenberg-Marquardt fitter and the Stehfest inversion are used outside
// well testing too (the fluid tuning work leans on the same lmFit). The
// domain re-exports them so a consumer has one import surface rather than
// having to know which half of the repo a function came from.
export * from '../../lib/welltest/numerics.js';
