// Command surface for the `repack-atlas` bin (T7): help texts and the
// shared output plumbing. Handlers live next to the composition root
// (`src/cli.ts`); this module holds only presentation constants and tiny
// formatters so `cli.ts` stays a readable dispatcher.

export const ROOT_HELP = `repack-atlas — local tooling for Re.Pack Module Federation workspaces

Usage
  repack-atlas <command> [options]

Commands
  dev         Run the workspace: supervised dev servers + read-only Studio
  doctor      Compare host and remote federation manifests
  inspect     Pretty-print a federation manifest (file, directory or URL)
  init        Generate/repair a repack-federation.json skeleton

Options
  --version   Print the version
  --help      Print this help

Exit codes
  0  clean (warnings allowed)
  1  ran and found errors ("bad answer")
  2  could not answer (bad input, missing/corrupt host manifest, no readable
     remote manifest)
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
     manifest that does not exist (MISSING_REMOTE_MANIFEST) or exists but
     cannot be read (MANIFEST_UNREADABLE) is a finding, not a failure to run.
     NOTHING_COMPARED (warning) means no remote manifest was compared; it
     adds no exit-code rule (only --fail-on-warnings escalates it)
  2  could not answer (unknown option/mode, no config found, host manifest
     missing or corrupt, every remote manifest exists but is unreadable)
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
                      No "command" is written: \`dev\` builds each app's
                      react-native start argv from its "root".
  --dry-run           Print the plan, write nothing
  --json              Machine-readable plan/result
  --help              Print this help

Exit codes
  0  plan printed or config written/repaired
  2  could not answer (no apps discovered, workspace missing)
`;

export const DEV_HELP = `repack-atlas dev — supervised workspace runner + read-only Studio

Usage
  repack-atlas dev [--workspace [dir]] [--apps <list>] [--port <n>]
                   [--auto-ports] [--platform <ios|android>]
                   [--standalone <remote>] [--studio-port <n>] [--no-studio]
                   [--ci] [--dry-run] [--json]

An app with a "root" starts through the argv Atlas builds, like upstream
Re.Pack's federation dev runner: node <the app's own react-native CLI>
start --bundler <rspack|webpack> [--config <path>] --port <n>
--no-interactive, run without a shell and with the app root as cwd. The CLI
is resolved from each app's own root (missing = exit 2 naming the app). The
bundler comes from the entry's "config" file name (a path relative to the
config directory, passed as an absolute --config), else from the
rspack.config.* / webpack.config.* in the app root (rspack wins; webpack only
when it alone exists; none = rspack). An explicit "command" (host.command or
remotes.<name>.command) overrides that: it runs verbatim through a shell
with the workspace config's directory as cwd. Both kinds get ATLAS_APP_NAME,
ATLAS_APP_PORT, ATLAS_APP_ROOT and ATLAS_APP_MANIFEST (absolute file
manifests only) in their environment, plus ATLAS_APP_PLATFORM with
--platform and ATLAS_APP_STANDALONE=1 on the --standalone remote: a "command"
is never rewritten, so env is its only channel (built argvs carry
--platform / --standalone as flags). Apps with neither "command" nor
"root" are skipped with a warning, never guessed.
Readiness = the app's port answers on 127.0.0.1 (declared ports are
probed free BEFORE spawning; remotes without one get a free port via
ATLAS_APP_PORT). Host port: --port > host "port" in the config > 8081.

Options
  --workspace [dir]    Discover repack-federation.json walking up from dir
                       (default: cwd)
  --apps <list>        Comma-separated config keys to run (host, remotes.<name>)
  --port <n>           Host port (1-65535); overrides the config host "port"
                       and the 8081 default. Remotes keep their declared
                       port, else a free one.
  --auto-ports         Move a busy declared/default port to a free one
                       (reported on stderr) instead of failing
  --platform <p>       ios or android (anything else exits 2). Built argvs
                       start with --platform <p>; "command" apps get
                       ATLAS_APP_PLATFORM=<p>. Shown in the plan.
  --standalone <name>  Run that remote standalone. It must be declared in
                       "remotes" with "standalone": true (else exit 2) and
                       joins the session even when --apps omits it. Only it
                       gets --standalone (ATLAS_APP_STANDALONE=1 for a
                       "command"); the rest of the session is unchanged.
  --studio-port <n>    Studio port (0 = ephemeral; default: first free from
                       8099)
  --no-studio          Do not serve the Studio
  --ci                 No key handling even on a TTY (browser never opens)
  --dry-run            Print the plan (app, role, port or auto, effective
                       command line, cwd)
                       and exit: nothing spawns, no Studio. Declared ports
                       are probed; every busy one is reported together and
                       exits 1 (--auto-ports reassigns them instead).
  --json               One JSON event per line: {event:'plan',apps} once
                       before anything spawns (app, role, final port;
                       null = auto in --dry-run, effective command line, cwd),
                       {event:'studio',url} once,
                       {event:'app',app,status,port} per status transition
                       (additive: reassignedFrom on an app --auto-ports
                       moved; platform / standalone:true on plan apps),
                       {event:'exit',code} last. With --dry-run only plan
                       and exit are emitted, identical across runs. Child
                       logs stay [name]-prefixed plain lines: keep only
                       lines starting with {.
  --help               Print this help

Keys (interactive TTY only; degrades to Ctrl-C without one)
  v / o   Open the Studio URL in the browser (the URL is logged regardless)
  q       Quit — same as Ctrl-C (SIGINT → grace → kill each process group)

Exit codes
  0  clean shutdown, no app died unexpectedly
  1  an app died unexpectedly during the session, or declared ports are
     busy or declared by two apps (all conflicts reported together; live
     and --dry-run)
  2  could not answer (bad argv incl. invalid --port / --platform /
     --studio-port, no/invalid config, unknown --apps name, unknown
     --standalone remote or one without "standalone": true, an app whose
     react-native CLI cannot be resolved, no free Studio port, Studio could
     not listen)
`;
