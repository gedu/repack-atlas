// Discovery-only fixture: init never evaluates this file, so it has no
// plugin imports and does not need the fixtures/<name>/apps/<app> depth.
export default { mode: 'development', entry: './src/index.js' };
