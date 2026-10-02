// Adapters (docs/PRD.md §6.1): the only layer allowed to touch the outside
// world — filesystem, network, child processes, user config files. Each file
// implements a core-owned port; core never imports anything here (lint
// fence `atlas/core-boundary`). Allowed imports: Node builtins, `src/core`
// (types + pure helpers), and `src/repack-bridge` through its index only —
// bundler packages (`@rspack/*`, `webpack`, `@module-federation/*`,
// `@callstack/repack`) may NOT be imported directly here (lint fence
// `atlas/adapter-boundary`).
//
// Deferred by task, with the typed seam already in place:
//   - T7 (`init`): the CLI-flag/workspace merge (`resolveFederationWorkspace`
//     upstream) and config evaluation (`extractShared`/dry-run) — they need
//     to load user rspack configs, which the T0 decision keeps out of
//     in-process scope until then.
//   - T9 (runner): consumes `ProcessRunner`; no extra adapter expected.

export * from './project-fs.js';
export * from './manifest-source.js';
export * from './workspace-config.js';
export * from './process-runner.js';
export * from './port-owner.js';
export * from './introspection.js';
export * from './react-native-cli.js';
export * from './prompts-clack.js';
export * from './prompts-readline.js';
export * from './prompts.js';
