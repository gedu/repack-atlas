// Federation Studio (docs/PRD.md §7.2): the read-only graph viewer.
// Direction of dependency holds — studio consumes core + adapters, never the
// other way around. The runner (T9) imports `createStudioServer` and pushes
// `notify()`; nothing here spawns processes or writes to disk.

export * from './page.js';
export * from './server.js';
export * from './workspace.js';
