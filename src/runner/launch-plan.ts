// Pure launch plan (ODD dev-wizard-runner T5, callstack/repack PR #1467
// `launchPlan.ts`): which session app gets the device launch and the exact
// one-shot argv. No I/O beyond the injected CLI resolver call, so the CLI,
// `--dry-run` and the supervisor share one answer.
//
// Target: the `--standalone` remote when the session has one (a standalone
// session is served by that remote alone), else the host. The react-native
// CLI is resolved from the TARGET's own root — even when the target runs a
// `command` override, because the launch needs a CLI no matter how the dev
// server starts; a target with no root has nowhere to resolve it from.
//
// `--no-packager` always: the session's dev servers ARE the packager, and a
// second one would fight for the port or split bundle serving away from the
// federation session. `--device` rides as one verbatim argv entry (no shell; a Windows `.cmd`
// shim is run via `cmd.exe` with every argument quoted, see `cmdShimSpawn`).
//
// A hoisted shim is shown by its absolute path, so `--dry-run --json` output
// for such installs is machine-specific.

import type { ReactNativeCliResult } from '../core/index.js';
import type { DevPlanEntry, DevPlatform } from './plan.js';
import { cliInvocation, describeArgv, describeShim } from './start-argv.js';

/** The one-shot `run-<platform>` child, in the supervisor's spawn shape. */
export interface LaunchPlan {
  /** Config key of the app whose first `ready` triggers the launch. */
  triggerKey: string;
  /** Graph node name of that app (what the plan shows). */
  app: string;
  /** The target's `.bin/react-native` shim, else `process.execPath` (PATH is
   * never consulted). */
  file: string;
  /** `[<cli script if node>, run-<platform>, --no-packager, ...]`. */
  args: string[];
  /** A Windows `.cmd` shim: spawned through `cmd.exe` with quoted args. */
  shell?: boolean;
  /** True when `file` is the shim (display only). */
  viaShim?: true;
  /** The target root. */
  cwd: string;
}

export type BuildLaunchPlanResult =
  | { ok: true; launch: LaunchPlan }
  | { ok: false; reason: string };

export interface BuildLaunchPlanInput {
  /** The session's planned apps (after `--apps` / `--standalone` selection). */
  entries: readonly DevPlanEntry[];
  /** `--platform`; launching needs exactly one (the CLI gates this first). */
  platform: DevPlatform;
  /** `--device`, passed through verbatim. */
  device?: string;
  /** Resolves the react-native CLI of one app root (port call, injected). */
  resolveCli(root: string): ReactNativeCliResult;
}

export function buildLaunchPlan(
  input: BuildLaunchPlanInput
): BuildLaunchPlanResult {
  const target =
    input.entries.find((entry) => entry.standalone === true) ??
    input.entries.find((entry) => entry.role === 'host');
  if (target === undefined) {
    return {
      ok: false,
      reason:
        '--launch needs the host (or the --standalone remote) in the session, but neither is running: add host to --apps, or pass --standalone <remote>',
    };
  }
  if (target.root === undefined) {
    return {
      ok: false,
      reason: `--launch: ${target.key} declares no "root" in repack-federation.json, so there is no react-native CLI to run run-${input.platform} with (declare its root, or pass --no-launch)`,
    };
  }
  const cli = input.resolveCli(target.root);
  if (cli.status !== 'ok') {
    return {
      ok: false,
      reason: `--launch: ${target.key}: ${cli.message} (app root ${target.root})`,
    };
  }
  const invocation = cliInvocation(cli);
  return {
    ok: true,
    launch: {
      triggerKey: target.key,
      app: target.name,
      file: invocation.file,
      ...(invocation.shell === true ? { shell: true } : {}),
      ...(invocation.cli === undefined ? { viaShim: true as const } : {}),
      args: [
        ...(invocation.cli !== undefined ? [invocation.cli] : []),
        `run-${input.platform}`,
        '--no-packager',
        ...(input.device !== undefined ? ['--device', input.device] : []),
      ],
      cwd: target.root,
    },
  };
}

/** The launch as the plan table / `plan` event shows it (additive `launch`). */
export interface DevPlanEventLaunch {
  app: string;
  command: string;
  cwd: string;
}

export function toPlanEventLaunch(launch: LaunchPlan): DevPlanEventLaunch {
  return {
    app: launch.app,
    command:
      launch.viaShim === true
        ? describeShim(launch.file, launch.args, launch.cwd)
        : describeArgv(launch.args, launch.cwd),
    cwd: launch.cwd,
  };
}

/** One human line for `--dry-run`, after the plan table. */
export function formatLaunchLine(launch: LaunchPlan): string {
  const shown = toPlanEventLaunch(launch);
  return `launch (once ${shown.app} is ready): ${shown.command}  [cwd ${shown.cwd}]`;
}
