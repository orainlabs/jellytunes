import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Without `timeout-minutes`, GitHub Actions defaults to a 6-hour job timeout.
 * A hung job then occupies a runner for the whole afternoon and its logs are
 * not readable until it finishes, so it produces neither a fail nor a
 * diagnosis. The 2026-09-11 incident with build-test.yml run 34575486832 is
 * the worked example that motivated this guard.
 *
 * Workflows are discovered by reading `.github/workflows/` (not by hardcoding
 * a list), so a new workflow that ships without a timeout is caught
 * automatically — the same defect ci-node-version.test.ts guards against.
 *
 * Per-workflow minima were chosen by the operator on 2026-09-28 to be
 * generous: they must cut only real hangs, never a slow but healthy build.
 * build-test.yml and release.yml build the Snap via LXD; the slowest green
 * Linux run on record (34597779199) was 88m 30s, so 180 leaves 2× headroom.
 */
const MIN_TIMEOUT_MINUTES: Readonly<Record<string, number>> = {
  'checks.yml': 30,
  'deploy-workers.yml': 30,
  'build-test.yml': 180,
  'release.yml': 180,
};

const workflowsDir = join('.github', 'workflows');
const workflowPaths = readdirSync(workflowsDir)
  .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
  .map((file) => join(workflowsDir, file));

const workflowsByFile = new Map(workflowPaths.map((path) => [path.split(/[\\/]/).pop()!, path]));

describe('Workflow timeouts', () => {
  it('discovers at least one workflow in .github/workflows/', () => {
    expect(workflowPaths.length).toBeGreaterThan(0);
  });

  it('covers every workflow in .github/workflows/ with a minimum', () => {
    // Symmetric guard: every discovered workflow must be in the minima table.
    // The "presence" test below would silently stop firing for a workflow
    // removed from the table, so this catches drift in either direction.
    for (const file of workflowsByFile.keys()) {
      expect(
        MIN_TIMEOUT_MINUTES,
        `${file} is missing from MIN_TIMEOUT_MINUTES — add an entry before merging`,
      ).toHaveProperty(file);
    }
  });

  it.each(workflowPaths)('%s declares a top-level timeout-minutes', (workflowPath) => {
    const workflow = readFileSync(workflowPath, 'utf8');

    // GitHub Actions requires `timeout-minutes` to be at the job level
    // (https://docs.github.com/en/actions/using-jobs/setting-a-timeout-for-a-job).
    // A YAML document can also have a top-level `timeout-minutes` for
    // workflow-level defaults; both count for the absence-of-hang guarantee.
    const hasJobOrWorkflowTimeout = /^\s*timeout-minutes:\s*\d+/m.test(workflow);
    expect(hasJobOrWorkflowTimeout).toBe(true);
  });

  it.each(Object.entries(MIN_TIMEOUT_MINUTES))(
    '%s declares timeout-minutes of at least %d minutes',
    (file, minimum) => {
      const workflowPath = workflowsByFile.get(file);
      expect(workflowPath, `workflow ${file} is missing from .github/workflows/`).toBeDefined();
      const workflow = readFileSync(workflowPath!, 'utf8');

      // Pick up every `timeout-minutes: N` line so a future split into
      // multiple jobs keeps the assertion meaningful. We assert on the
      // minimum across all declared values because the cheapest hang is the
      // first to fire.
      const declaredValues = [...workflow.matchAll(/^\s*timeout-minutes:\s*(\d+)\s*$/gm)].map(
        (match) => Number(match[1]),
      );

      expect(declaredValues.length).toBeGreaterThan(0);
      for (const value of declaredValues) {
        expect(value).toBeGreaterThanOrEqual(minimum);
      }
    },
  );
});
