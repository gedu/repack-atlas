// Node adapter for the `ProjectFs` port (docs/PRD.md §6.3 wrapper rule:
// the user project's filesystem is wrapped so tests run on fixture dirs).
// Thin on purpose: absence is a value (`null`/`false`/`[]`), not an
// exception; anything else (permissions, EIO) is a programming-level
// surprise and surfaces as a throw — callers that must distinguish it use
// `stat` (`null` = cannot answer).

import { readdir, readFile as fsReadFile, stat } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import type { FileStat, ProjectFs } from '../core/ports.js';

/** Directory names the walk prunes when no explicit list is given. */
export const DEFAULT_WALK_IGNORE_DIRS = [
  'node_modules',
  '.git',
  'build',
  'dist',
  'coverage',
];

/** Default ceiling on walk results — a wrong ignore list must not hang Atlas. */
export const DEFAULT_WALK_MAX_ENTRIES = 5000;

function isErrnoNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function toFileStat(s: Stats): FileStat {
  return { isDirectory: s.isDirectory(), sizeBytes: s.size };
}

export function createNodeProjectFs(): ProjectFs {
  return {
    async stat(filePath: string): Promise<FileStat | null> {
      try {
        return toFileStat(await stat(filePath));
      } catch (error) {
        if (isErrnoNotFound(error)) return null;
        // Unstatable (permissions, EIO, …): "cannot answer" is the honest
        // answer for a port whose contract encodes absence in the return.
        return null;
      }
    },

    async exists(filePath: string): Promise<boolean> {
      try {
        await stat(filePath);
        return true;
      } catch {
        return false;
      }
    },

    async readFile(filePath: string): Promise<string | null> {
      try {
        return await fsReadFile(filePath, 'utf-8');
      } catch {
        return null;
      }
    },

    async readdir(dirPath: string): Promise<string[]> {
      try {
        return await readdir(dirPath);
      } catch {
        return [];
      }
    },

    async walk(
      rootDir: string,
      options: { ignoreDirNames?: string[]; maxEntries?: number } = {}
    ): Promise<string[]> {
      const ignore = new Set(
        options.ignoreDirNames ?? DEFAULT_WALK_IGNORE_DIRS
      );
      const maxEntries = options.maxEntries ?? DEFAULT_WALK_MAX_ENTRIES;
      const results: string[] = [];

      async function walkDir(relative: string): Promise<boolean> {
        const absolute = relative ? path.join(rootDir, relative) : rootDir;
        let entries: Dirent[];
        try {
          entries = await readdir(absolute, { withFileTypes: true });
        } catch {
          return true; // unreadable subtree: skip, keep walking
        }
        for (const entry of entries) {
          if (results.length >= maxEntries) return false; // budget exhausted
          const entryRelative = relative
            ? `${relative}/${entry.name}`
            : entry.name;
          if (entry.isDirectory()) {
            if (ignore.has(entry.name)) continue;
            if (!(await walkDir(entryRelative))) return false;
          } else {
            results.push(entryRelative);
          }
        }
        return true;
      }

      await walkDir('');
      results.sort();
      return results;
    },
  };
}
