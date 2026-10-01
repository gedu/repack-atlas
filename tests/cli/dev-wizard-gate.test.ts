// Wizard gate + wiring through `runDevCommand` (in process, `--dry-run`, so
// nothing spawns): the wizard shows up only for a human on a TTY, its answers
// land in the same plan the flags build, and cancel exits 0 with no plan.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { runDevCommand, type DevEnv } from '../../src/cli/dev.js';
import { repoRoot } from './run-bin.js';
import { CANCEL, fakePrompts, type ScriptedAnswer } from './fake-prompts.js';

const WORKSPACE = path.join(repoRoot, 'fixtures', 'workspace');
const tmpDirs: string[] = [];
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Host + one standalone-capable remote, both `command` apps (never run). */
function standaloneWorkspace(remotePort: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'atlas-wizard-'));
  tmpDirs.push(dir);
  writeFileSync(
    path.join(dir, 'repack-federation.json'),
    JSON.stringify({
      host: { manifest: './host.json', command: 'echo host' },
      remotes: {
        solo: {
          manifest: './solo.json',
          command: 'echo solo',
          standalone: true,
          port: remotePort,
        },
      },
    })
  );
  return dir;
}

interface Run {
  code: number;
  out: string;
  err: string;
  created: number;
  prompts: ReturnType<typeof fakePrompts>;
}

async function dev(
  args: string[],
  script: ScriptedAnswer[],
  tty: { stdout: boolean; stdin: boolean } = { stdout: true, stdin: true }
): Promise<Run> {
  const prompts = fakePrompts(script);
  let created = 0;
  const env: DevEnv = {
    stdoutIsTTY: tty.stdout,
    stdinIsTTY: tty.stdin,
    createPrompts: async () => {
      created += 1;
      return prompts;
    },
  };
  let out = '';
  let err = '';
  const code = await runDevCommand(
    args,
    {
      writeOut: (text) => void (out += `${text}\n`),
      writeErr: (text) => void (err += `${text}\n`),
    },
    env
  );
  return { code, out, err, created, prompts };
}

describe('dev wizard gate', () => {
  it('does not prompt with --apps, --no-interactive, --ci, --json or a non-TTY', async () => {
    const host = String(await freePort());
    const base = ['--workspace', WORKSPACE, '--dry-run', '--port', host];
    const cases: Array<[string, string[], { stdout: boolean; stdin: boolean }?]> = [
      ['--apps', ['--apps', 'host']],
      ['--no-interactive', ['--no-interactive']],
      ['--ci', ['--ci']],
      ['--json', ['--json']],
      ['non-TTY stdout', [], { stdout: false, stdin: true }],
      ['non-TTY stdin', [], { stdout: true, stdin: false }],
    ];
    for (const [label, extra, tty] of cases) {
      const run = await dev([...base, ...extra], [], tty);
      assert.equal(run.created, 0, `${label}: prompts were created`);
      assert.equal(run.prompts.asked.length, 0, label);
      assert.equal(run.code, 0, `${label}: ${run.err}`);
    }
  });

  it('runs on a TTY and builds the plan from the answers (dry-run too)', async () => {
    const host = await freePort();
    const hostOverride = await freePort();
    const storePort = await freePort();
    const run = await dev(
      ['--workspace', WORKSPACE, '--dry-run', '--port', String(host)],
      [
        ['mini_store'], // remotes: drop mini_auth
        'android',
        false, // launch: no
        false, // host: override
        String(hostOverride),
        false, // mini_store: override
        String(storePort),
      ]
    );
    assert.equal(run.code, 0, run.err);
    assert.equal(run.created, 1);
    assert.equal(run.prompts.closed, 1);
    const table = run.out;
    assert.match(table, new RegExp(`^host\\s+host\\s+${hostOverride}\\b`, 'm'));
    assert.match(table, new RegExp(`^mini_store\\s+remote\\s+${storePort}\\b`, 'm'));
    assert.doesNotMatch(table, /mini_auth/);
    assert.match(table, /platform/);
    assert.match(table, /android/);
  });

  it('offers standalone only for remotes declaring it and plans it', async () => {
    const hostPort = await freePort();
    const soloPort = await freePort();
    const dir = standaloneWorkspace(soloPort);
    const run = await dev(
      ['--workspace', dir, '--dry-run', '--port', String(hostPort)],
      // remotes, platform "all", host port, solo port, standalone yes
      [['solo'], 'all', true, true, true]
    );
    assert.equal(run.code, 0, run.err);
    assert.ok(
      run.prompts.asked.includes('confirm: Run solo in standalone mode?')
    );
    assert.match(run.out, /remote \(standalone\)/);
  });

  it('cancel exits 0 with no plan and nothing started', async () => {
    const host = String(await freePort());
    for (const script of [[CANCEL], [['mini_auth'], CANCEL]] as ScriptedAnswer[][]) {
      const run = await dev(
        ['--workspace', WORKSPACE, '--port', host],
        script
      );
      assert.equal(run.code, 0);
      assert.equal(run.out, '');
      assert.equal(run.err, '');
      assert.deepEqual(run.prompts.cancels, ['Session cancelled.']);
      assert.equal(run.prompts.closed, 1);
    }
  });

  it('reports a bad flag combination before any prompt (exit 2)', async () => {
    const run = await dev(
      ['--workspace', WORKSPACE, '--standalone', 'nope', '--dry-run'],
      []
    );
    assert.equal(run.code, 2);
    assert.equal(run.created, 0);
    assert.match(run.err, /--standalone names an unknown remote/);
  });

  it('never offers "all" under --launch, so the plan stays valid', async () => {
    const host = String(await freePort());
    const run = await dev(
      ['--workspace', WORKSPACE, '--port', host, '--platform', 'ios', '--launch', '--dry-run'],
      [['mini_auth'], 'ios', true, true]
    );
    // The platform question must not offer "all" under --launch (there is no
    // `run-all`), so the answers stay a valid plan.
    const platformQuestion = run.prompts.offered.find((question) =>
      question.message.includes('platform')
    );
    assert.ok(platformQuestion, 'the platform question was asked');
    assert.deepEqual(platformQuestion.values, ['ios', 'android']);
    // The answers are accepted as is: the run only stops later (exit 2, could
    // not answer), at the launch target's react-native CLI, which the fixture
    // app does not install.
    assert.equal(run.code, 2, run.err);
    assert.doesNotMatch(run.err, /--launch needs a single platform/);
    assert.match(run.err, /cannot resolve the "react-native" package/);
    assert.equal(run.prompts.remaining(), 0);
  });
});
