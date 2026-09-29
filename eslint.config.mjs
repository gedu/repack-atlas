// ESLint 9 flat config.
//
// Two named architectural restrictions carry the weight of the hexagonal
// layout (docs/PRD.md 6.1, 6.2). They are enforced here so review does not
// have to carry them:
//
//   1. `atlas/bridge-fence`  — only code under `src/repack-bridge/` may import
//                             anything under a `vendored/` directory. Vendored
//                             Re.Pack code is a deliberate, reviewed surface and
//                             must stay behind the bridge (PRD 6.2 rule 1).
//   2. `atlas/core-boundary` — `src/core/` is bundler-agnostic: it may not import
//                             the bridge, the adapters, or any bundler/federation
//                             package (PRD 6.1, goal G5).
//
// Implementation note: both use core `no-restricted-imports` with `patterns`,
// which matches the import specifier as written. Resolution-based rules
// (`import/no-restricted-paths`) were tried first and silently did NOT fire,
// because this project's NodeNext ESM sources import each other with `.js`
// specifiers that no default resolver maps onto `.ts` files — a fence that
// never reports is worse than no fence, so matching the specifier is deliberate.

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const BRIDGE_FENCE_MESSAGE =
  'bridge-fence: vendored Re.Pack code may only be imported from src/repack-bridge/** (docs/PRD.md 6.2). Change src/repack-bridge/index.ts instead.';

const CORE_BOUNDARY_MESSAGE =
  'core-boundary: src/core/** must stay bundler-agnostic (docs/PRD.md 6.1). Consume the outside world through a port implemented by an adapter, never by importing it directly.';

/** Anything resolving into a `vendored/` directory, from any relative depth. */
const vendoredPathPatterns = [
  '**/vendored',
  '**/vendored/**',
  '*/vendored',
  '*/vendored/**',
];

/** Bundler / federation packages forbidden inside the core. */
const coreForbiddenPackagePatterns = [
  '@callstack/repack',
  '@callstack/repack/**',
  '@module-federation/**',
  '@rspack/**',
  'webpack',
  'webpack/**',
];

/** Relative paths forbidden inside the core. */
const coreForbiddenLocalPatterns = [
  '**/repack-bridge',
  '**/repack-bridge/**',
  '**/adapters',
  '**/adapters/**',
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      // Fixture workspaces simulate user projects, they are not Atlas source.
      'fixtures/**',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // 1. bridge-fence: every source file except the bridge itself.
  {
    name: 'atlas/bridge-fence',
    files: ['src/**/*.ts'],
    ignores: ['src/repack-bridge/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: vendoredPathPatterns,
              message: BRIDGE_FENCE_MESSAGE,
            },
          ],
        },
      ],
    },
  },

  // 2. core-boundary.
  {
    name: 'atlas/core-boundary',
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                ...coreForbiddenPackagePatterns,
                ...coreForbiddenLocalPatterns,
              ],
              message: CORE_BOUNDARY_MESSAGE,
            },
            {
              // The core block replaces `no-restricted-imports` for these
              // files, so the vendored fence is repeated here rather than
              // inherited from atlas/bridge-fence.
              group: vendoredPathPatterns,
              message: BRIDGE_FENCE_MESSAGE,
            },
          ],
        },
      ],
    },
  },

  // 3. adapter-boundary: adapters touch the world through Node builtins,
  //    core, and the bridge index — never a bundler package directly. The
  //    core fence cannot cover them (adapters are not src/core), so without
  //    this block an adapter could `import { rspack } from '@rspack/core'`
  //    and bypass the vendor→swap plan (PRD 6.2).
  {
    name: 'atlas/adapter-boundary',
    files: ['src/adapters/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: coreForbiddenPackagePatterns,
              message:
                'adapter-boundary: src/adapters/** may reach Re.Pack/rspack only through src/repack-bridge (docs/PRD.md 6.2). Extend the bridge index instead.',
            },
            {
              group: vendoredPathPatterns,
              message: BRIDGE_FENCE_MESSAGE,
            },
          ],
        },
      ],
    },
  },

  {
    // Node scripts run outside the published package; no type-aware linting.
    // They are plain JS, so `no-undef` is live and the Node globals they use
    // must be declared (kept explicit instead of pulling in the `globals`
    // package for a handful of names).
    name: 'atlas/scripts',
    files: ['scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
  },
);
