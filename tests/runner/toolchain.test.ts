// Unit tests for per-app toolchain resolution (no processes, injected ports).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ProjectFs,
  ReactNativeCliResolver,
  ReactNativeCliResult,
} from '../../src/core/index.js';
import { resolveToolchains } from '../../src/runner/toolchain.js';

const resolver: ReactNativeCliResolver = {
  resolve: (root) => ({ status: 'ok', cli: `${root}/cli.js` }),
  startOptions: () => ({ status: 'ok', options: ['--port'] }),
};

/** Contract-honest fake: absence is `null` / `[]`, never a throw. */
const listing = (
  stat: ProjectFs['stat'],
  readdir: ProjectFs['readdir'] = async () => []
): { fs: ProjectFs } => ({ fs: { stat, readdir } as ProjectFs });

const DIR = { isDirectory: true, sizeBytes: 0 };

describe('resolveToolchains bundler detection', () => {
  it('says so when the app root cannot be read and rspack is only assumed', async () => {
    const toolchains = await resolveToolchains([{ root: '/ws/a' }], {
      ...listing(async () => null),
      reactNativeCli: resolver,
    });
    const a = toolchains['/ws/a']!;
    assert.ok(a.ok);
    assert.equal(a.bundler, 'rspack');
    assert.match(a.bundlerNote ?? '', /app root could not be read.*falling back to rspack/);
  });

  it('treats a root that is not a directory as unreadable', async () => {
    const toolchains = await resolveToolchains([{ root: '/ws/a' }], {
      ...listing(async () => ({ isDirectory: false, sizeBytes: 1 })),
      reactNativeCli: resolver,
    });
    const a = toolchains['/ws/a']!;
    assert.ok(a.ok);
    assert.match(a.bundlerNote ?? '', /could not be read/);
  });

  it('stays quiet when the config field decides the bundler anyway', async () => {
    const toolchains = await resolveToolchains(
      [{ root: '/ws/a', config: 'webpack.config.js' }],
      { ...listing(async () => null), reactNativeCli: resolver }
    );
    const a = toolchains[`/ws/a\u0000webpack.config.js`]!;
    assert.ok(a.ok);
    assert.equal(a.bundler, 'webpack');
    assert.equal(a.bundlerNote, undefined);
  });

  it('has no note when the root lists fine, even with no config file', async () => {
    const toolchains = await resolveToolchains([{ root: '/ws/a' }], {
      ...listing(async () => DIR),
      reactNativeCli: resolver,
    });
    const a = toolchains['/ws/a']!;
    assert.ok(a.ok);
    assert.equal(a.bundlerNote, undefined);
  });
});

const okCli = (root: string): ReactNativeCliResult => ({
  status: 'ok',
  cli: `${root}/node_modules/react-native/cli.js`,
});

describe('resolveToolchains (injected resolver edge cases)', () => {
  it('a resolver that throws fails that app only, not the plan', async () => {
    const toolchains = await resolveToolchains(
      [{ root: '/ws/a' }, { root: '/ws/b' }],
      {
        ...listing(async () => DIR),
        reactNativeCli: {
          resolve(root) {
            if (root === '/ws/a') throw new Error('boom');
            return okCli(root);
          },
          startOptions: () => ({ status: 'unknown', message: 'n/a' }),
        },
      }
    );
    const a = toolchains['/ws/a']!;
    assert.ok(!a.ok);
    assert.match(a.reason, /lookup failed: Error: boom/);
    assert.ok(toolchains['/ws/b']!.ok);
  });
});
