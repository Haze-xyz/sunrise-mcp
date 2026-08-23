#!/usr/bin/env node
/**
 * Table-driven test of decideOverlayOutcome / describeOverlayOutcome / leftChanges
 * (dist/overlay-decision.js) and countPatch (dist/overlay.js). No git, no checkout.
 *
 * The case that carries the design: being behind upstream stops the run by default. It is not a
 * warning printed on the way past -- measured, eight days of drift costs a third of the patch, and
 * a tree full of avoidable conflict markers is a worse answer than "sync first".
 */

import assert from 'node:assert/strict';
import {
  decideOverlayOutcome,
  describeOverlayOutcome,
  leftChanges,
} from '../dist/overlay-decision.js';
import { countPatch } from '../dist/overlay.js';

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err instanceof Error ? err.stack ?? err.message : String(err) });
    console.log(`FAIL  ${name}`);
    console.log(err instanceof Error ? err.stack ?? err.message : String(err));
  }
}

const base = {
  isCheckout: true,
  workingTreeClean: true,
  commitsBehindUpstream: 0,
  driftAccepted: false,
  applyAttempted: true,
  conflictedFiles: [],
  applyError: null,
};

const CASES = [
  { name: 'a current, clean checkout -> applied', o: {}, expected: 'applied' },
  { name: 'not a checkout -> notACheckout', o: { isCheckout: false }, expected: 'notACheckout' },
  { name: 'uncommitted work -> dirty, before anything is written', o: { workingTreeClean: false }, expected: 'dirty' },
  {
    name: 'behind upstream -> drifted, refused by default',
    o: { commitsBehindUpstream: 43 },
    expected: 'drifted',
  },
  {
    name: 'behind upstream with --allow-drift -> the apply is allowed to proceed',
    o: { commitsBehindUpstream: 43, driftAccepted: true },
    expected: 'applied',
  },
  {
    name: 'conflict markers -> appliedWithConflicts, not applied',
    o: { conflictedFiles: ['log.cpp', 'bap_route.cpp'] },
    expected: 'appliedWithConflicts',
  },
  {
    name: 'git refusing the patch outright -> failed, never applied',
    o: { applyError: 'error: patch does not apply (git exit 1)' },
    expected: 'failed',
  },
  {
    name: 'an apply that never ran cannot be a success',
    o: { applyAttempted: false },
    expected: 'aborted',
  },
  {
    name: 'a nonsense behind-count is reported, not treated as current',
    o: { commitsBehindUpstream: -1 },
    expected: 'aborted',
  },
  {
    name: 'a dirty checkout outranks drift: nothing is written either way',
    o: { workingTreeClean: false, commitsBehindUpstream: 43 },
    expected: 'dirty',
  },
];

async function main() {
  for (const c of CASES) {
    await test(c.name, () => {
      assert.equal(decideOverlayOutcome({ ...base, ...c.o }).kind, c.expected);
    });
  }

  await test('only an outcome that wrote something reports having written something', () => {
    for (const c of CASES) {
      const outcome = decideOverlayOutcome({ ...base, ...c.o });
      const wrote = outcome.kind === 'applied' || outcome.kind === 'appliedWithConflicts';
      assert.equal(leftChanges(outcome), wrote, `${outcome.kind} reported wrongly`);
    }
  });

  await test('the drift refusal names the fix rather than only the problem', () => {
    const line = describeOverlayOutcome({ kind: 'drifted', behind: 43 });
    assert.ok(line.includes('43'), line);
    assert.ok(line.includes('sync-fork'), 'it must name the command that fixes it');
    assert.ok(line.includes('--allow-drift'), 'it must name the way past it');
  });

  await test('every outcome describes itself', () => {
    const outcomes = [
      { kind: 'notACheckout' },
      { kind: 'dirty' },
      { kind: 'drifted', behind: 1 },
      { kind: 'applied', behind: 0 },
      { kind: 'appliedWithConflicts', behind: 0, files: ['a.cpp'] },
      { kind: 'failed', reason: 'x' },
      { kind: 'aborted', reason: 'y' },
    ];
    for (const outcome of outcomes) {
      const line = describeOverlayOutcome(outcome);
      assert.ok(typeof line === 'string' && line.length > 30, `${outcome.kind}: ${line}`);
    }
    assert.ok(describeOverlayOutcome(outcomes[4]).includes('a.cpp'), 'conflicts must be named');
  });

  await test('a patch is counted by what it does, added apart from modified', () => {
    const patch = [
      'diff --git a/new.cpp b/new.cpp',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.cpp',
      '@@ -0,0 +1 @@',
      '+int main() {}',
      'diff --git a/old.cpp b/old.cpp',
      'index 111..222 100644',
      '--- a/old.cpp',
      '+++ b/old.cpp',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    assert.deepEqual(countPatch(patch), { added: 1, modified: 1 });
    assert.deepEqual(countPatch(''), { added: 0, modified: 0 });
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('overlay smoke test crashed:', err);
  process.exit(1);
});
