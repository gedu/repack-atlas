// Unit tests for per-app toolchain resolution (no processes, injected ports).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ProjectFs,
  ReactNativeCliResolver,
} from '../../src/core/index.js';
import { resolveToolchains } from '../../src/runner/toolchain.js';

const resolver: ReactNativeCliResolver = {
  resolve: (root) => ({ status: 'ok', cli: `${root}/cli.js` }),
  startOptions: () => ({ status: 'ok', options: ['--port'] }),
};

const listing = (readdir: ProjectFs['readdir']): { fs: ProjectFs } =>
  ({ fs: { readdir } as ProjectFs });

describe('resolveToolchains bundler detection', () => {
  it('says so when the app root cannot be listed and rspack is only assumed', async () => {
    const toolchains = await resolveToolchains([{ root: '/ws/a' }], {
      ...listing(async () => {
        throw new Error('EACCES');
      }),
      reactNativeCli: resolver,
    });
    const a = toolchains['/ws/a']!;
    assert.ok(a.ok);
    assert.equal(a.bundler, 'rspack');
    assert.match(a.bundlerNote ?? '', /could not list the app root.*EACCES.*assuming rspack/);
  });

  it('stays quiet when the config field decides the bundler anyway', async () => {
    const toolchains = await resolveToolchains(
      [{ root: '/ws/a', config: 'webpack.config.js' }],
      {
        ...listing(async () => {
          throw new Error('EACCES');
        }),
        reactNativeCli: resolver,
      }
    );
    const a = toolchains[`/ws/a\u0000webpack.config.js`]!;
    assert.ok(a.ok);
    assert.equal(a.bundler, 'webpack');
    assert.equal(a.bundlerNote, undefined);
  });

  it('has no note when the root lists fine, even with no config file', async () => {
    const toolchains = await resolveToolchains([{ root: '/ws/a' }], {
      ...listing(async () => []),
      reactNativeCli: resolver,
    });
    const a = toolchains['/ws/a']!;
    assert.ok(a.ok);
    assert.equal(a.bundlerNote, undefined);
  });
});
