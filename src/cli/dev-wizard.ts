// Interactive wizard for `repack-atlas dev` (ODD dev-wizard-runner T6), the
// Atlas counterpart of upstream Re.Pack's federation dev wizard (#1467).
// Steps: remotes -> platform -> launch -> ports -> standalone. It is an INPUT
// SOURCE only: the answers become the same plan inputs the flags drive (apps,
// platform, per-app ports, standalone, launch), so there is one execution
// path and no second set of gates. Questions go through a `PromptPort`.

import type { PromptPort } from '../core/index.js';
import {
  DEV_PLATFORMS,
  HOST_APP_KEY,
  type DevPlanEntry,
  type DevPlatform,
} from '../runner/plan.js';

export const WIZARD_CANCELLED_LINE = 'Session cancelled.';

/** Said out loud instead of silently skipping the launch question. */
export const LAUNCH_NEEDS_PLATFORM_LINE =
  'Launch skipped: launching the app needs a single platform (ios or android).';

/** Gate inputs, all already derived from argv and the terminal. */
export interface WizardGateInput {
  /** `--apps` was given: the user already chose the session. */
  hasApps: boolean;
  /** `--no-interactive` or `--ci` (which implies it). */
  noInteractive: boolean;
  json: boolean;
  stdoutIsTTY: boolean;
  stdinIsTTY: boolean;
}

/**
 * The wizard runs only for a human at a terminal who has not already decided:
 * upstream's gate (no `--apps`, not `--no-interactive`, stdout is a TTY) plus
 * `--json`/`--ci` (machine output) and a TTY stdin (prompts must be answerable).
 * `--dry-run` does not suppress it, as upstream.
 */
export function shouldRunWizard(gate: WizardGateInput): boolean {
  return (
    !gate.hasApps &&
    !gate.noInteractive &&
    !gate.json &&
    gate.stdoutIsTTY &&
    gate.stdinIsTTY
  );
}

export interface WizardContext {
  /** First-pass plan (every app): its ports are the wizard's defaults. */
  entries: DevPlanEntry[];
  /** Config keys of the remotes that declare `standalone: true`. */
  standaloneRemotes: string[];
  /** `--platform`, when given: preselected, still changeable. */
  platform?: DevPlatform;
  /** An explicit `--launch` / `--no-launch`: used as is, never re-asked. */
  launch?: boolean;
}

/** Plan inputs the answers produce; each overrides its flag counterpart. */
export interface WizardAnswers {
  /** Config keys: `host` plus the selected remotes. */
  apps: string[];
  platform?: DevPlatform;
  /** Absent when launch was never on the table (platform "all"). */
  launch?: boolean;
  /** Port per config key, as confirmed or overridden. */
  ports: Record<string, number>;
  standalone?: string;
}

export type WizardOutcome =
  | { status: 'completed'; answers: WizardAnswers }
  | { status: 'cancelled' };

export const validatePortInput = (value: string): string | undefined => {
  const port = /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? undefined
    : 'Enter an integer port between 1 and 65535.';
};

export async function runDevWizard(
  prompts: PromptPort,
  context: WizardContext
): Promise<WizardOutcome> {
  const cancelled = (): WizardOutcome => {
    prompts.cancel(WIZARD_CANCELLED_LINE);
    return { status: 'cancelled' };
  };

  // 1. Remotes. The host is always in the session; with nothing to choose
  // from there is nothing to ask.
  const remotes = context.entries.filter((entry) => entry.role === 'remote');
  let selected: string[] = [];
  if (remotes.length > 0) {
    const answer = await prompts.multiselect({
      message: 'Which remotes to run?',
      options: remotes.map((entry) => ({
        value: entry.key,
        label: entry.key,
      })),
      initialValues: remotes.map((entry) => entry.key),
      // An empty pick is a host-only session, like `--apps host`.
      emptyHint: 'host only',
    });
    if (answer.status === 'cancelled') return cancelled();
    selected = answer.value;
  }

  // 2. Platform. An explicit `--launch` needs a single platform (there is no
  // `run-all`), so "all" is not offered then: the answer stays valid by
  // construction instead of failing after the last prompt.
  const platformAnswer = await prompts.select({
    message: 'Which app platform are you running?',
    options: [
      { value: 'ios', label: 'iOS' },
      { value: 'android', label: 'Android' },
      ...(context.launch === true
        ? []
        : [{ value: 'all', label: 'All / decide later' }]),
    ],
    initialValue: context.platform ?? (context.launch === true ? 'ios' : 'all'),
  });
  if (platformAnswer.status === 'cancelled') return cancelled();
  const platform = DEV_PLATFORMS.find(
    (candidate) => candidate === platformAnswer.value
  );

  // 3. Launch: only for one platform, and never what a flag already decided.
  let launch = context.launch;
  if (launch === undefined) {
    if (platform !== undefined) {
      const answer = await prompts.confirm({
        message: `Launch the app on ${platform} when the host is ready?`,
        initialValue: true,
      });
      if (answer.status === 'cancelled') return cancelled();
      launch = answer.value;
    } else {
      prompts.note(LAUNCH_NEEDS_PLATFORM_LINE);
    }
  }

  // 4. Ports for every app in the session. An app without a declared port is
  // `auto` (the runner picks a free one) unless the user names one.
  const ports: Record<string, number> = {};
  for (const entry of context.entries) {
    if (entry.role === 'remote' && !selected.includes(entry.key)) continue;
    const declared = entry.declaredPort;
    const keep = await prompts.confirm({
      message:
        declared === null
          ? `Let ${entry.name} use an automatic free port?`
          : `Use port ${declared} for ${entry.name}?`,
      initialValue: true,
    });
    if (keep.status === 'cancelled') return cancelled();
    if (keep.value) {
      if (declared !== null) ports[entry.key] = declared;
      continue;
    }
    const override = await prompts.text({
      message: `Port for ${entry.name}:`,
      validate: validatePortInput,
    });
    if (override.status === 'cancelled') return cancelled();
    ports[entry.key] = Number(override.value);
  }

  // 5. Standalone: only selected remotes that declare it, at most one.
  let standalone: string | undefined;
  for (const key of selected) {
    if (!context.standaloneRemotes.includes(key)) continue;
    const answer = await prompts.confirm({
      message: `Run ${key} in standalone mode?`,
      initialValue: false,
    });
    if (answer.status === 'cancelled') return cancelled();
    if (answer.value) {
      standalone = key;
      break;
    }
  }

  return {
    status: 'completed',
    answers: {
      apps: [HOST_APP_KEY, ...selected],
      ...(platform !== undefined ? { platform } : {}),
      ...(launch !== undefined ? { launch } : {}),
      ports,
      ...(standalone !== undefined ? { standalone } : {}),
    },
  };
}
