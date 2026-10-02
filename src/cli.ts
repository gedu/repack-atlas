#!/usr/bin/env node
// The `repack-atlas` bin (T7): a thin composition root. Arg parsing is
// hand-rolled (no new deps), every decision lives in core or the adapters —
// this file only wires ports to adapters, maps results to stdout/stderr and
// owns the process exit code (AGENTS.md rule 6: 0 clean · 1 bad answer ·
// 2 could not answer; 1 and 2 must stay distinguishable).

import path from 'node:path';
import {
  doctorExitCode,
  doctorReportToJson,
  formatManifest,
} from './core/index.js';
import {
  createConfigIntrospector,
  createManifestSource,
  createNodeProjectFs,
  createWorkspaceConfigReader,
} from './adapters/index.js';
import { lastValue, parseArgs, type ArgSpec } from './cli/args.js';
import { formatDoctorFindings } from './cli/format.js';
import {
  DOCTOR_HELP,
  INIT_HELP,
  INSPECT_HELP,
  ROOT_HELP,
} from './cli/help.js';
import { runDevCommand } from './cli/dev.js';
import {
  buildDoctorPlan,
  runDoctorFromPlan,
  type EndpointPlan,
} from './cli/plan.js';
import {
  buildInitPlan,
  formatInitPlan,
  initPlanToJson,
  writeInitConfig,
} from './cli/init.js';
// G4: the version reader is shared with the dev banner (src/cli/version.ts);
// `--version` behavior is exactly as before.
import { readVersion } from './cli/version.js';

const EXIT_CLEAN = 0;
const EXIT_NO_ANSWER = 2;

/** Shared composition: the one ProjectFs instance every adapter shares. */
function compose() {
  const fs = createNodeProjectFs();
  return {
    fs,
    manifestSource: createManifestSource(fs),
    configReader: createWorkspaceConfigReader(fs),
    introspector: createConfigIntrospector(fs),
  };
}

function writeOut(text: string): void {
  process.stdout.write(`${text}\n`);
}

function writeErr(text: string): void {
  process.stderr.write(`${text}\n`);
}

/** True when the command should print help instead of running. */
function wantsHelp(parsed: { flags: Set<string> }): boolean {
  return parsed.flags.has('help');
}

// --- doctor -------------------------------------------------------------------

const DOCTOR_SPEC: ArgSpec = {
  valueOptions: ['host', 'remote'],
  optionalValueOptions: ['workspace'],
  booleanFlags: ['json', 'allow-missing-manifests', 'fail-on-warnings', 'help'],
};

async function runDoctorCommand(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, DOCTOR_SPEC);
  if (wantsHelp(parsed)) {
    writeOut(DOCTOR_HELP);
    return EXIT_CLEAN;
  }
  if (parsed.error) {
    writeErr(`doctor: ${parsed.error}`);
    writeErr(DOCTOR_HELP);
    return EXIT_NO_ANSWER;
  }

  const { manifestSource, configReader } = compose();
  const workspaceFlag = parsed.options.has('workspace');
  const hostRef = lastValue(parsed, 'host');
  const plan = await buildDoctorPlan({
    configReader,
    remoteRefs: parsed.values.get('remote') ?? [],
    ...(hostRef !== undefined ? { hostRef } : {}),
    ...(workspaceFlag
      ? { workspaceDir: lastValue(parsed, 'workspace') ?? process.cwd() }
      : {}),
  });

  if (!plan.ok) {
    return reportPlanFailure('doctor', plan.reasons, parsed.flags.has('json'));
  }

  const allowMissing = parsed.flags.has('allow-missing-manifests');
  const failOnWarnings = parsed.flags.has('fail-on-warnings');
  const run = await runDoctorFromPlan(plan, manifestSource, {
    allowMissingManifests: allowMissing,
  });
  const exitCode = doctorExitCode(run.report, { failOnWarnings });

  if (parsed.flags.has('json')) {
    // exitCode in the payload must mirror the process exit code, flag included.
    writeOut(doctorReportToJson(run.report, { failOnWarnings }));
    return exitCode;
  }

  printDoctorSources(run.sources, plan.host, plan.remotes);
  writeOut(formatDoctorFindings(run.report.findings));
  if (run.report.unableToAnswer) {
    writeOut('could not answer (exit 2): the run had no usable input.');
  }
  return exitCode;
}


function printDoctorSources(
  sources: {
    host: { name: string; resolvedFrom?: string; failure?: string };
    remotes: { name: string; resolvedFrom?: string }[];
  },
  hostPlan: EndpointPlan,
  remotePlans: EndpointPlan[]
): void {
  const where = (resolved?: string, fallback?: string): string =>
    resolved ?? fallback ?? 'unknown';
  const lines = [
    `host:   ${sources.host.name}  ${where(sources.host.resolvedFrom, sources.host.failure ?? hostPlan.manifest)}`,
  ];
  remotePlans.forEach((remote, index) => {
    const source = sources.remotes[index];
    lines.push(
      `remote: ${remote.name}  ${where(source?.resolvedFrom, remote.manifest)}`
    );
  });
  writeOut(`${lines.join('\n')}\n`);
}

function reportPlanFailure(
  command: string,
  reasons: string[],
  json: boolean
): number {
  if (json) {
    writeOut(
      JSON.stringify(
        {
          tool: 'repack-atlas',
          doctorVersion: '1',
          exitCode: EXIT_NO_ANSWER,
          summary: { errors: 1, warnings: 0, advisories: 0, infos: 0 },
          findings: [
            {
              severity: 'error',
              code: 'UNABLE_TO_ANSWER',
              confidence: 'static',
              message: `${command}: ${reasons.join('; ')}`,
            },
          ],
        },
        null,
        2
      )
    );
  } else {
    for (const reason of reasons) writeErr(`${command}: ${reason}`);
  }
  return EXIT_NO_ANSWER;
}

// --- inspect --------------------------------------------------------------------

const INSPECT_SPEC: ArgSpec = {
  valueOptions: [],
  optionalValueOptions: [],
  booleanFlags: ['json', 'help'],
};

async function runInspectCommand(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, INSPECT_SPEC);
  if (wantsHelp(parsed)) {
    writeOut(INSPECT_HELP);
    return EXIT_CLEAN;
  }
  if (parsed.error) {
    writeErr(`inspect: ${parsed.error}`);
    writeErr(INSPECT_HELP);
    return EXIT_NO_ANSWER;
  }
  if (parsed.positional.length !== 1) {
    writeErr(
      `inspect: exactly one <path|url> argument is required (got ${parsed.positional.length})`
    );
    writeErr(INSPECT_HELP);
    return EXIT_NO_ANSWER;
  }

  const ref = parsed.positional[0]!;
  const { manifestSource } = compose();
  const result = await manifestSource.load(ref);

  if (result.status === 'failed') {
    // Inspect answers about ONE manifest; nothing usable means no answer.
    writeErr(`inspect: ${result.message}`);
    return EXIT_NO_ANSWER;
  }

  if (parsed.flags.has('json')) {
    writeOut(JSON.stringify(result.manifest, null, 2));
  } else {
    writeOut(`source: ${result.resolvedFrom}`);
    writeOut(formatManifest(result.manifest));
  }
  return EXIT_CLEAN;
}

// --- init -----------------------------------------------------------------------

const INIT_SPEC: ArgSpec = {
  valueOptions: [],
  optionalValueOptions: ['workspace'],
  booleanFlags: ['dry-run', 'json', 'help'],
};

async function runInitCommand(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, INIT_SPEC);
  if (wantsHelp(parsed)) {
    writeOut(INIT_HELP);
    return EXIT_CLEAN;
  }
  if (parsed.error) {
    writeErr(`init: ${parsed.error}`);
    writeErr(INIT_HELP);
    return EXIT_NO_ANSWER;
  }
  if (parsed.positional.length > 0) {
    writeErr(`init: unexpected argument ${parsed.positional[0]}`);
    writeErr(INIT_HELP);
    return EXIT_NO_ANSWER;
  }

  const { fs, introspector } = compose();
  const workspace = lastValue(parsed, 'workspace') ?? process.cwd();
  const result = await buildInitPlan(workspace, fs, introspector);
  if (!result.ok) {
    if (parsed.flags.has('json')) {
      writeOut(
        JSON.stringify(
          {
            tool: 'repack-atlas',
            command: 'init',
            exitCode: EXIT_NO_ANSWER,
            error: result.reason,
          },
          null,
          2
        )
      );
    } else {
      writeErr(`init: ${result.reason}`);
    }
    return EXIT_NO_ANSWER;
  }

  const dryRun = parsed.flags.has('dry-run');
  if (!dryRun) {
    try {
      await writeInitConfig(result.plan, async (filePath, content) => {
        const { mkdir, writeFile } = await import('node:fs/promises');
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, content, 'utf-8');
      });
    } catch (error) {
      writeErr(
        `init: ${error instanceof Error ? error.message : String(error)}`
      );
      return EXIT_NO_ANSWER;
    }
  }

  if (parsed.flags.has('json')) {
    writeOut(initPlanToJson(result.plan, !dryRun));
  } else {
    writeOut(formatInitPlan(result.plan, !dryRun));
  }
  return EXIT_CLEAN;
}

// --- entry point ------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === '--version' || command === '-v' || command === '-V') {
    writeOut(`repack-atlas ${await readVersion()}`);
    return EXIT_CLEAN;
  }
  if (
    command === undefined ||
    command === '--help' ||
    command === '-h' ||
    command === 'help'
  ) {
    writeOut(ROOT_HELP);
    return command === undefined ? EXIT_NO_ANSWER : EXIT_CLEAN;
  }

  switch (command) {
    case 'dev':
      return runDevCommand(rest, {
        writeOut(text) {
          writeOut(text);
          // The runner is long-lived: flush what it prints as it goes.
        },
        writeErr(text) {
          writeErr(text);
        },
      });
    case 'doctor':
      return runDoctorCommand(rest);
    case 'inspect':
      return runInspectCommand(rest);
    case 'init':
      return runInitCommand(rest);
    default: {
      writeErr(`repack-atlas: unknown command ${command}`);
      writeErr(ROOT_HELP);
      return EXIT_NO_ANSWER;
    }
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Anything escaping the typed layers is a bug, not an answer.
    writeErr(`repack-atlas: unexpected failure: ${String(error)}`);
    process.exitCode = EXIT_NO_ANSWER;
  });
