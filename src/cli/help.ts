// Command surface for the `repack-atlas` bin (T7): help texts and the
// shared output plumbing. Handlers live next to the composition root
// (`src/cli.ts`); this module holds only presentation constants and tiny
// formatters so `cli.ts` stays a readable dispatcher.

export const ROOT_HELP = `repack-atlas — local tooling for Re.Pack Module Federation workspaces

Usage
  repack-atlas <command> [options]

Commands
  doctor      Compare host and remote federation manifests
  inspect     Pretty-print a federation manifest (file, directory or URL)
  init        Generate/repair a repack-federation.json skeleton

Options
  --version   Print the version
  --help      Print this help

Exit codes
  0  clean (warnings allowed)
  1  ran and found errors ("bad answer")
  2  could not answer (bad input, missing/corrupt host manifest)
`;

export const DOCTOR_HELP = `repack-atlas doctor — compare host and remote federation manifests

Usage
  repack-atlas doctor --host <path|url> --remote <path|url> [--remote ...]
  repack-atlas doctor [--workspace [dir]]

Input modes (mutually exclusive)
  --host <ref>          Host manifest: .json file, directory containing
                        repack-federation-manifest.json, or URL
  --remote <ref>        Remote manifest, repeatable (one per remote)
  --workspace [dir]     Discover repack-federation.json walking up from dir
                        (default: cwd) and read manifest refs from it

Options
  --json                        Machine-readable report (see the --json
                                contract: tool/exitCode/summary/findings)
  --allow-missing-manifests     Downgrade MISSING_REMOTE_MANIFEST from error
                                to warning (exit stays 0 without other errors)
  --fail-on-warnings            Opt-in: static warnings also exit 1 (CI gate
                                mode). Heuristic advisories never escalate.
  --help                        Print this help

Exit codes
  0  clean (warnings allowed by default)
  1  ran and found errors (or warnings with --fail-on-warnings); a remote
     manifest that does not exist is a finding, not a failure to run
  2  could not answer (unknown option/mode, no config found, host manifest
     missing or corrupt, a remote manifest that exists but cannot be read)
`;

export const INSPECT_HELP = `repack-atlas inspect — pretty-print a federation manifest

Usage
  repack-atlas inspect <path|url> [--json]

  <path|url>   .json file, directory containing
               repack-federation-manifest.json, or http(s) URL

Options
  --json   Print the manifest document as JSON instead of the summary
  --help   Print this help

Exit codes
  0  manifest printed
  2  could not answer (missing argument, unreadable or unparseable manifest)
`;

export const INIT_HELP = `repack-atlas init — generate/repair a repack-federation.json skeleton

Scope note: the minimal reduced-scope init. The full upstream init (#1466:
single-source shared config from installed versions, feature scan,
extractShared) is deferred; this command only discovers apps and wires the
workspace config.

Usage
  repack-atlas init [--workspace [dir]] [--dry-run] [--json]

  --workspace [dir]   Workspace to scan (default: cwd). Apps are discovered
                      as subdirectories of <workspace>/apps containing a
                      rspack.config.* file; federation facts come from each
                      app's .repack-atlas/introspection.json when present.
  --dry-run           Print the plan, write nothing
  --json              Machine-readable plan/result
  --help              Print this help

Exit codes
  0  plan printed or config written/repaired
  2  could not answer (no apps discovered, workspace missing)
`;
