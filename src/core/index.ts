// Bundler-agnostic domain (docs/PRD.md §6.1): findings model, pure doctor
// rule engine, semver-range math, REMOTE_CYCLE detection, exit-code mapping
// and the ports adapters implement. Nothing here may import the bridge,
// adapters or any bundler package — enforced by the `atlas/core-boundary`
// lint rule.
export * from './manifest-types.js';
export * from './findings.js';
export * from './semverRange.js';
export * from './cycle.js';
export * from './exit-codes.js';
export * from './doctor.js';
export * from './ports.js';
