// Unit tests for the pure dev-TUI view-model (odd/tasks T2): roster order,
// status/one-shot ingestion, ring buffer, spinner-frame collapsing,
// classification, navigation and the status→glyph/color map. No ink, no
// react, no terminal — data in, assertions out. Also covers the pure render
// selectors the TUI consumes (F4): logWindow, partitionPinned and
// renderProgressFrame.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createDevTuiModel,
  collapseCandidate,
  completeProgressFrame,
  classifyLine,
  isTerminalBuildLine,
  logWindow,
  partitionPinned,
  renderProgressFrame,
  statusPresentation,
  STATUS_PRESENTATION,
  type DevTuiLine,
  type DevTuiModel,
  type DevTuiRosterEntry,
} from '../../src/cli/dev-tui/model.js';
import type { DevAppPlan } from '../../src/runner/supervisor.js';

// Roster built from plan-shaped entries (structurally a DevAppPlan[]): host,
// two remotes, one of them port-reassigned.
const host: DevAppPlan = {
  key: 'host',
  name: 'host_app',
  role: 'host',
  launch: { kind: 'command', command: 'run' },
  cwd: '/ws/apps/host',
  port: 8081,
  portSource: 'declared',
};
const alpha: DevAppPlan = {
  key: 'alpha',
  name: 'alpha',
  role: 'remote',
  launch: { kind: 'command', command: 'run' },
  cwd: '/ws/apps/alpha',
  port: 8082,
  portSource: 'reassigned',
  reassignedFrom: 9082,
};
const beta: DevAppPlan = {
  key: 'beta',
  name: 'beta',
  role: 'remote',
  launch: { kind: 'command', command: 'run' },
  cwd: '/ws/apps/beta',
  port: 8083,
  portSource: 'declared',
};

function model(options: { launch?: boolean; ringCap?: number } = {}): DevTuiModel {
  const apps: readonly DevTuiRosterEntry[] = [alpha, beta, host];
  return createDevTuiModel({
    apps,
    ...(options.launch === true ? { launchName: 'launch' } : {}),
    ...(options.ringCap !== undefined ? { ringCap: options.ringCap } : {}),
  });
}

describe('roster', () => {
  it('orders host first, remotes in plan order, launch last', () => {
    const m = model({ launch: true });
    assert.deepEqual(
      m.rows().map((row) => [row.key, row.role, row.status]),
      [
        ['host', 'host', 'pending'],
        ['alpha', 'remote', 'pending'],
        ['beta', 'remote', 'pending'],
        ['launch', 'oneshot', 'pending'],
      ]
    );
    assert.equal(m.rows()[0]?.port, 8081);
    assert.equal(m.rows()[3]?.port, undefined);
  });

  it('carries reassignedFrom on the row', () => {
    const m = model();
    const [alphaRow] = m.rows().filter((row) => row.key === 'alpha');
    assert.equal(alphaRow?.reassignedFrom, 9082);
    const renderRow = m.visibleRows().find((row) => row.key === 'alpha');
    assert.equal(renderRow?.portLabel, '8082 (was 9082)');
  });

  it('has no launch row without a launch plan', () => {
    const m = model();
    assert.deepEqual(
      m.rows().map((row) => row.key),
      ['host', 'alpha', 'beta']
    );
    assert.equal(m.oneShot('launch', { status: 'started', pid: 1 }), false);
  });

  it('rejects logs and statuses for unknown apps', () => {
    const m = model({ launch: true });
    assert.equal(m.log('ghost', 'stdout', 'hello'), false);
    assert.equal(m.status('ghost', 'ready', 1234), false);
    assert.deepEqual(m.lines('ghost'), []);
    assert.equal(m.hiddenCount('ghost'), 0);
    assert.equal(m.selectKey('ghost'), false);
  });
});

describe('status ingestion', () => {
  it('updates rows by graph name, port and pid', () => {
    const m = model();
    assert.equal(m.status('host_app', 'starting', 8081, 4242), true);
    assert.equal(m.status('host_app', 'ready', 8081, 4242), true);
    const hostRow = m.rows().find((row) => row.key === 'host');
    assert.equal(hostRow?.status, 'ready');
    assert.equal(hostRow?.port, 8081);
    assert.equal(hostRow?.pid, 4242);
  });

  it('maps one-shot events to honest statuses', () => {
    const m = model({ launch: true });
    m.oneShot('launch', { status: 'started', pid: 7 });
    assert.equal(m.rows()[3]?.status, 'starting');
    assert.equal(m.rows()[3]?.pid, 7);

    m.oneShot('launch', { status: 'exited', code: 0, signal: null });
    assert.equal(m.rows()[3]?.status, 'exited');

    m.oneShot('launch', { status: 'exited', code: 1, signal: null });
    assert.equal(m.rows()[3]?.status, 'error');

    m.oneShot('launch', { status: 'exited', code: null, signal: 'SIGTERM' });
    assert.equal(m.rows()[3]?.status, 'error');

    m.oneShot('launch', { status: 'spawn-failed' });
    assert.equal(m.rows()[3]?.status, 'error');
  });

  it('refuses app statuses on the one-shot row and one-shots on apps', () => {
    const m = model({ launch: true });
    assert.equal(m.status('launch', 'ready', 0), false);
    assert.equal(
      m.oneShot('host_app', { status: 'started', pid: 1 }),
      false
    );
  });
});

describe('ring buffer', () => {
  it('drops oldest lines first and counts them hidden', () => {
    const m = model({ ringCap: 3 });
    for (const text of ['l1', 'l2', 'l3', 'l4', 'l5']) {
      m.log('host', 'stdout', text);
    }
    assert.deepEqual(
      m.lines('host').map((line) => line.text),
      ['l3', 'l4', 'l5']
    );
    assert.equal(m.hiddenCount('host'), 2);
  });

  it('exposes the hidden count of the selected app in the snapshot', () => {
    const m = model({ ringCap: 2 });
    m.log('host', 'stdout', 'a');
    m.log('host', 'stdout', 'b');
    m.log('host', 'stdout', 'c');
    const snapshot = m.snapshot();
    assert.equal(snapshot.selectedKey, 'host');
    assert.equal(snapshot.hiddenLines, 1);
    assert.deepEqual(
      snapshot.lines.map((line) => line.text),
      ['b', 'c']
    );
  });
});

describe('spinner-frame collapsing', () => {
  it('collapses repeated dotted frames into one updating live line', () => {
    const m = model({ launch: true });
    for (const dots of ['', '.', '..', '...', '......']) {
      m.log('launch', 'stdout', `- Building the app${dots}`);
    }
    const lines = m.lines('launch');
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.text, '- Building the app......');
    assert.equal(lines[0]?.live, true);
    assert.equal(lines[0]?.kind, 'progress');
  });

  it('collapses trailing-dot floods beyond the old 6-dot cap (F7)', () => {
    // The smoke saw `Building the app........` (8 dots) survive next to the
    // 5-dot frame: the normalizer used to ignore dot runs longer than 6.
    const m = model({ launch: true });
    for (const dots of [5, 8, 12, 30, 1]) {
      m.log('launch', 'stdout', `- Building the app${'.'.repeat(dots)}`);
    }
    const lines = m.lines('launch');
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.text, `- Building the app${'.'.repeat(1)}`);
    assert.equal(lines[0]?.live, true);
    // Pure-helper side: any dots-only variation shares one collapse key.
    assert.equal(collapseCandidate('- Building the app........'), '- Building the app');
    assert.equal(collapseCandidate('- Building the app........................'), '- Building the app');
  });

  it('collapses braille + percentage progress across changing values', () => {
    const m = model();
    m.log('host', 'stdout', '⠋ [14:37:11.074Z][DevServer] [======----------] 39% ios');
    m.log('host', 'stdout', '⠙ [14:37:11.512Z][DevServer] [========--------] 55% ios');
    m.log('host', 'stdout', '⠹ [14:37:12.001Z][DevServer] [==========------] 71% ios');
    const lines = m.lines('host');
    assert.equal(lines.length, 1);
    assert.equal(
      lines[0]?.text,
      '⠹ [14:37:12.001Z][DevServer] [==========------] 71% ios'
    );
    assert.equal(lines[0]?.live, true);
  });

  it('collapses a bare braille-spinner label', () => {
    const m = model();
    m.log('host', 'stdout', '⠋ installing dependencies');
    m.log('host', 'stdout', '⠙ installing dependencies');
    assert.equal(m.lines('host').length, 1);
  });

  it('never collapses error lines', () => {
    const m = model();
    m.log('host', 'stdout', '× ...[timeout] connection terminated...');
    m.log('host', 'stdout', '× ...[timeout] connection terminated...');
    assert.equal(m.lines('host').length, 2);
    assert.equal(collapseCandidate('⠋ building, 1 error so far'), undefined);
  });

  it('settles the live line as normal when a different line arrives', () => {
    const m = model({ launch: true });
    m.log('launch', 'stdout', '- Building the app...');
    m.log('launch', 'stdout', '- Building the app..');
    m.log('launch', 'stdout', 'Bundled in 15s');
    const lines = m.lines('launch');
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.live, undefined);
    assert.equal(lines[1]?.text, 'Bundled in 15s');
    assert.equal(lines[1]?.live, undefined);
  });

  it('final plain frame settles onto the live line', () => {
    const m = model({ launch: true });
    m.log('launch', 'stdout', '- Building the app...');
    m.log('launch', 'stdout', '- Building the app');
    const lines = m.lines('launch');
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.text, '- Building the app');
  });

  it('does NOT collapse plain non-animation repeats', () => {
    const m = model();
    m.log('host', 'stdout', 'server listening');
    m.log('host', 'stdout', 'server listening');
    assert.equal(m.lines('host').length, 2);
    assert.equal(collapseCandidate('server listening'), undefined);
  });

  it('does not collapse across streams', () => {
    const m = model();
    m.log('host', 'stdout', '- Building the app...');
    m.log('host', 'stderr', '- Building the app...');
    assert.equal(m.lines('host').length, 2);
  });

  it('refuses long lines and links', () => {
    assert.equal(collapseCandidate('x'.repeat(120)), undefined);
    assert.equal(
      collapseCandidate('⠋ see https://example.com/mf.json 50%'),
      undefined
    );
    assert.equal(collapseCandidate('- Building the app...'), '- Building the app');
  });
});

describe('line classification', () => {
  it('classifies real demo lines by their own markers', () => {
    assert.equal(classifyLine('- Building the app...'), 'progress');
    assert.equal(
      classifyLine(
        'ℹ [14:37:11.074Z][DevServer] [======----------] 39% ios'
      ),
      'progress'
    );
    assert.equal(
      classifyLine('⚠ Warning in Bundle DevServer: Slow dependencies'),
      'warn'
    );
    assert.equal(
      classifyLine('✓ ... Compiled ios in 15.3s'),
      'success'
    );
    assert.equal(
      classifyLine('× ...[timeout] connection terminated by host'),
      'error'
    );
    assert.equal(classifyLine('Dev Server is running'), 'info');
  });

  it('error markers beat the progress shape', () => {
    assert.equal(classifyLine('[====----] 40% failed ×'), 'error');
  });
});

describe('navigation', () => {
  it('starts on the first row and clamps at both ends', () => {
    const m = model({ launch: true });
    assert.equal(m.selectedIndex(), 0);
    m.selectPrev();
    assert.equal(m.selectedIndex(), 0);
    m.selectLast();
    assert.equal(m.selectedIndex(), 3);
    m.selectNext();
    assert.equal(m.selectedIndex(), 3);
    m.selectFirst();
    assert.equal(m.selectedIndex(), 0);
  });

  it('steps with next/prev', () => {
    const m = model({ launch: true });
    m.selectNext();
    m.selectNext();
    assert.equal(m.selectedRow()?.key, 'beta');
    m.selectPrev();
    assert.equal(m.selectedRow()?.key, 'alpha');
  });

  it('selects by key or graph name', () => {
    const m = model();
    assert.equal(m.selectKey('alpha'), true);
    assert.equal(m.selectedRow()?.key, 'alpha');
    assert.equal(m.selectKey('host_app'), true);
    assert.equal(m.selectedRow()?.key, 'host');
  });
});

describe('render rows and status map', () => {
  it('exposes glyph + color per status from the exported map', () => {
    const m = model();
    m.status('host', 'ready', 8081);
    m.status('alpha', 'starting', 8082);
    const rows = m.visibleRows();
    assert.deepEqual(
      rows.map((row) => [row.glyph, row.color]),
      [
        ['✓', 'green'],
        ['●', 'yellow'],
        ['○', 'gray'],
      ]
    );
  });

  it('covers every model status with a stable glyph/color', () => {
    const statuses = Object.keys(STATUS_PRESENTATION).sort();
    assert.deepEqual(statuses, [
      'bundling',
      'error',
      'exited',
      'idle',
      'pending',
      'ready',
      'starting',
      'stopped',
    ]);
    assert.deepEqual(statusPresentation('ready'), {
      glyph: '✓',
      color: 'green',
    });
    assert.deepEqual(statusPresentation('exited'), {
      glyph: '→',
      color: 'cyan',
    });
    assert.deepEqual(statusPresentation('error'), {
      glyph: '✗',
      color: 'red',
    });
    assert.deepEqual(statusPresentation('stopped'), {
      glyph: '○',
      color: 'gray',
    });
    assert.deepEqual(statusPresentation('pending'), {
      glyph: '○',
      color: 'gray',
    });
    assert.deepEqual(statusPresentation('starting'), {
      glyph: '●',
      color: 'yellow',
    });
  });

  it('keeps timestamps as caller-provided data only', () => {
    const m = model();
    m.log('host', 'stdout', 'hello', 1_700_000_000_000);
    m.log('host', 'stdout', 'world');
    const lines = m.lines('host');
    assert.equal(lines[0]?.at, 1_700_000_000_000);
    assert.equal(lines[1]?.at, undefined);
  });
});

describe('unread activity (F10)', () => {
  it('bumps unread only for rows that are not selected', () => {
    const m = model({ launch: true });
    // Selection starts on `host`: its logs are watched live.
    m.log('host', 'stdout', 'seen');
    m.log('alpha', 'stdout', 'one');
    m.log('alpha', 'stdout', 'two');
    const rows = new Map(m.visibleRows().map((row) => [row.key, row.unread]));
    assert.equal(rows.get('host'), 0);
    assert.equal(rows.get('alpha'), 2);
    assert.equal(rows.get('beta'), 0);
  });

  it('marks viewed by key or name, and selection-then-arrival stays clean', () => {
    const m = model({ launch: true });
    m.log('alpha', 'stdout', 'one');
    m.markViewed('alpha');
    assert.equal(
      m.visibleRows().find((row) => row.key === 'alpha')?.unread,
      0
    );
    // By graph name too (the app may call it with either).
    m.log('alpha', 'stdout', 'two');
    m.markViewed('alpha');
    m.selectKey('alpha');
    assert.equal(m.selectedKey(), 'alpha');
    // Now selected: logs stop counting as unread without any markViewed.
    m.log('alpha', 'stdout', 'three');
    assert.equal(
      m.visibleRows().find((row) => row.key === 'alpha')?.unread,
      0
    );
  });

  it('unread keeps counting while the selection moves away', () => {
    const m = model({ launch: true });
    m.selectKey('alpha');
    m.log('alpha', 'stdout', 'watched');
    m.selectKey('host');
    // The watched line was seen; a fresh one is unread.
    m.log('alpha', 'stdout', 'missed');
    assert.equal(
      m.visibleRows().find((row) => row.key === 'alpha')?.unread,
      1
    );
  });

  it('selectedKey exposes the row the viewer is on', () => {
    const m = model({ launch: true });
    assert.equal(m.selectedKey(), 'host');
    m.selectKey('beta');
    assert.equal(m.selectedKey(), 'beta');
  });
});

// ---------------------------------------------------------------------------
// Pure render selectors (F4): windowing, pinned progress bar, bar graphics
// ---------------------------------------------------------------------------

function line(text: string): DevTuiLine {
  return { stream: 'stdout', text, kind: classifyLine(text) };
}

describe('logWindow', () => {
  it('anchors at the bottom and clamps at the top of the buffer (F6)', () => {
    assert.deepEqual(logWindow(10, 0, 5), { start: 5, end: 10 });
    assert.deepEqual(logWindow(10, 3, 5), { start: 2, end: 7 });
    // F6: an offset deeper than the buffer can scroll shows the FIRST
    // pageHeight lines — never a short/blank tail.
    assert.deepEqual(logWindow(3, 100, 5), { start: 0, end: 3 });
    assert.deepEqual(logWindow(10, 100, 5), { start: 0, end: 5 });
    assert.deepEqual(logWindow(0, 5, 5), { start: 0, end: 0 });
  });
});

describe('partitionPinned', () => {
  it('no pin without a progress-shaped line', () => {
    const lines = [line('info: hello'), line('✔ Compiled')];
    const { pinned, body } = partitionPinned(lines);
    assert.equal(pinned, undefined);
    assert.deepEqual(body, lines);
  });

  it('pins the last progress bar while frames keep arriving', () => {
    const lines = [
      line('info: start'),
      line('transforming [===-------] 30%'),
      line('transforming [========---] 93%'),
    ];
    const { pinned, body } = partitionPinned(lines);
    assert.equal(pinned?.text, 'transforming [========---] 93%');
    assert.deepEqual(
      body.map((l) => l.text),
      ['info: start', 'transforming [===-------] 30%']
    );
  });

  it('later lines render ABOVE the pinned bar (pin rule, live buffer)', () => {
    // Model reality: frames collapse IN PLACE, so a live bar is the LAST
    // buffer line; lines printed before it stay in the body.
    const m = model();
    m.log('host', 'stdout', 'info: start');
    m.log('host', 'stdout', 'transforming [===-------] 30%');
    m.log('host', 'stdout', 'transforming [========---] 93%');
    const lines = m.lines('host');
    const { pinned, body } = partitionPinned(lines);
    assert.equal(pinned?.text, 'transforming [========---] 93%');
    assert.ok(body.some((l) => l.text === 'info: start'));
  });

  it('unpins once Compiled and later lines pushed the bar out of recency', () => {
    const lines = [
      line('transforming [========---] 93%'),
      line('✔ Compiled in 4.2s'),
      line('info: asset main.js 1.2 MiB'),
      line('info: listening on 8081'),
    ];
    const { pinned, body } = partitionPinned(lines);
    assert.equal(pinned, undefined);
    assert.equal(body.length, 4);
  });

  it('a bar frame still within the last lines pins even as a single frame', () => {
    // Recency is the activeness signal (frames collapse in place, so a live
    // bar sits at/near the buffer end): a fresh bar pins immediately.
    const { pinned } = partitionPinned([
      line('info: start'),
      line('transforming [====] 40%'),
    ]);
    assert.equal(pinned?.text, 'transforming [====] 40%');
  });

  it('a live dotted spinner is NOT pinned (F3 animates it in place)', () => {
    const spinner: DevTuiLine = {
      stream: 'stdout',
      text: '- Building the app......',
      kind: 'progress',
      live: true,
    };
    const { pinned, body } = partitionPinned([
      line('info: start'),
      spinner,
    ]);
    assert.equal(pinned, undefined);
    assert.equal(body.length, 2);
  });

  it('a terminal build line kills the pin and completes the bar in place (F8)', () => {
    // The trading case: the child jumps 98% -> `Compiled`, so the bar is
    // still the last progress-shaped line AND recent. The pin must die and
    // the bar must settle as ONE completed 100% frame at its own position —
    // never a pinned 98% bar parked under `✔ Compiled`, never duplicated.
    const lines = [
      line('info: start'),
      line('transforming [=================-] 98%'),
      line('✔ Compiled in 4.2s'),
    ];
    const { pinned, body } = partitionPinned(lines);
    assert.equal(pinned, undefined);
    assert.deepEqual(
      body.map((l) => l.text),
      ['info: start', 'transforming [██████████████████] 100%', '✔ Compiled in 4.2s']
    );
    assert.equal(
      body[1]?.live,
      undefined,
      'the settled final frame stops animating'
    );
  });

  it('an error terminal completes the bar too (F8)', () => {
    // kind error: the build ENDED (honestly); the bar's last frame shows
    // where it stopped, completed as the final redrawn outcome.
    const lines = [
      line('transforming [====-----] 40%'),
      line('× ...[timeout] compilation failed'),
    ];
    const { pinned, body } = partitionPinned(lines);
    assert.equal(pinned, undefined);
    assert.equal(body[0]?.text, 'transforming [█████████] 100%');
  });

  it('a plain later line does NOT complete the bar (only terminals do, F8)', () => {
    // `info: asset main.js` within recency: the build may keep going; the
    // bar stays pinned exactly as before (F4 unchanged for non-terminals).
    const lines = [
      line('transforming [====-----] 40%'),
      line('info: asset main.js 1.2 MiB'),
    ];
    const { pinned, body } = partitionPinned(lines);
    assert.equal(pinned?.text, 'transforming [====-----] 40%');
    assert.equal(body.length, 1);
  });
});

describe('isTerminalBuildLine (F8)', () => {
  it('success kind, error kind and compiled/success wording are terminal', () => {
    assert.equal(isTerminalBuildLine(line('✔ Compiled in 4.2s')), true);
    assert.equal(isTerminalBuildLine(line('success: bundle done')), true);
    assert.equal(isTerminalBuildLine(line('error: something broke')), true);
    assert.equal(isTerminalBuildLine(line('Build completed successfully')), true);
    assert.equal(isTerminalBuildLine(line('info: asset main.js')), false);
    assert.equal(isTerminalBuildLine(line('transforming [===] 40%')), false);
  });
});

describe('completeProgressFrame (F8)', () => {
  it('fills the bar and rewrites the percent to 100', () => {
    assert.equal(
      completeProgressFrame('transforming [=================-] 98%'),
      'transforming [██████████████████] 100%'
    );
  });

  it('is a no-op without a bracketed bar', () => {
    assert.equal(completeProgressFrame('✔ Compiled'), '✔ Compiled');
    assert.equal(completeProgressFrame('⠋ building'), '⠋ building');
  });
});

describe('renderProgressFrame', () => {
  it('expands the fill when the printed percent says 100', () => {
    assert.equal(
      renderProgressFrame('transforming [========--] 100%'),
      'transforming [██████████] 100%'
    );
  });

  it('is a no-op below 100, without a bar, or without a percent', () => {
    assert.equal(
      renderProgressFrame('transforming [===-------] 93%'),
      'transforming [===-------] 93%'
    );
    assert.equal(renderProgressFrame('info: plain line'), 'info: plain line');
    assert.equal(renderProgressFrame('transforming [===---]'), 'transforming [===---]');
  });

  it('a frame already fully drawn stays untouched', () => {
    assert.equal(
      renderProgressFrame('transforming [██████████] 100%'),
      'transforming [██████████] 100%'
    );
  });
});
