// mini_store — fixture remote rspack config (fake at the boundary: no rspack,
// no Re.Pack and no install is needed to consume this fixture).
// Atlas is not published under a name these apps can resolve, and fixture
// workspaces are consumed from spawned processes, so the plugins are imported
// through a plain relative path into the repo's build output:
//   fixtures/<workspace>/apps/<app>/rspack.config.js
//     -> ../../../../dist/repack-bridge/*.js  (the repo's dist/)
// Every fixture workspace MUST stay at exactly this depth
// (fixtures/<name>/apps/<app>) for the paths to hold. Until T7 ships the CLI,
// tests only check these configs parse as ESM and reference both plugins.
import { FederationManifestPlugin } from '../../../../dist/repack-bridge/plugin.js';
import { IntrospectionPlugin } from '../../../../dist/repack-bridge/introspection-plugin.js';

const federation = {
  name: 'mini_store',
  exposes: {"./<script>alert(1)</script>": "./src/<img src=x onerror=alert(2)>"},
  remotes: {},
  shared: {"react": {"singleton": true, "eager": true, "requiredVersion": "^19.0.0"}, "react-native": {"singleton": true, "eager": true, "requiredVersion": "~0.79.2"}, "\"><svg onload=alert(3)>": {"singleton": false, "eager": false, "requiredVersion": "^1.0.0"}},
};

const introspection = {
  name: 'mini_store',
  role: 'remote',
  exposes: ["./<script>alert(1)</script>"],
  remotes: {},
  shared: [{"name": "react", "version": "19.0.0", "singleton": true, "eager": true, "requiredVersion": "^19.0.0"}, {"name": "react-native", "version": "0.79.2", "singleton": true, "eager": true, "requiredVersion": "~0.79.2"}, {"name": "\"><svg onload=alert(3)>", "version": "1.0.0", "singleton": false, "eager": false, "requiredVersion": "^1.0.0"}],
  port: 8083,
  native: { reactNativeVersion: '0.79.2', newArch: true, platforms: ['ios', 'android'] },
};

export default {
  mode: 'development',
  context: new URL('.', import.meta.url).pathname,
  entry: './src/index.js',
  plugins: [
    new FederationManifestPlugin({ ...federation, manifest: true }),
    new IntrospectionPlugin(introspection),
  ],
};
