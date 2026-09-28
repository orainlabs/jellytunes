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
 * Both forms of `timeout-minutes` count toward the per-job coverage check:
 * a job-level declaration on the job itself and a workflow-level default
 * that applies to every job that does not override it. GitHub Actions
 * accepts either, but the guard requires N declarations for N jobs (either
 * N job-level entries or 1 workflow-level plus N-1 job-level entries) — a
 * workflow-level default alone is treated as 1 declaration, not N, so a
 * workflow that relies only on the default still needs an explicit
 * job-level declaration per job. Forcing the explicit form makes
 * regressions visible: if someone removes the workflow-level default, the
 * next missing job-level entry fails the test, instead of producing a
 * silent 6-hour hang. Reference:
 *   https://docs.github.com/en/actions/using-jobs/setting-a-timeout-for-a-job
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

// Map basename → full path so the minimums table can use filenames as keys
// without duplicating the .github/workflows/ prefix for every entry.
const workflowsByFile = new Map(workflowPaths.map((path) => [path.split(/[\\/]/).pop()!, path]));

/**
 * GitHub Actions job IDs are 2-space-indented YAML mappings under the top-level
 * `jobs:` key. Anchoring at `^  ` (two spaces, start of line) avoids matching
 * nested keys (e.g. `strategy:` or `steps:`), which are also 2-space indented
 * but live inside a job. Scanning starts after the `^jobs:` line and stops at
 * the next line at column 0, which is always the start of another top-level
 * key or end of file.
 */
function countJobIds(workflow: string): number {
  const jobsMatch = workflow.match(/^jobs:\s*$/m);
  if (!jobsMatch || jobsMatch.index === undefined) return 0;

  const afterJobs = workflow.slice(jobsMatch.index + jobsMatch[0].length);
  // Drop everything from the next column-0 line onward (next top-level key).
  const jobsBlock = afterJobs.split(/\n(?=\S)/, 1)[0] ?? '';
  const jobIdMatches = jobsBlock.match(/^ {2}[a-zA-Z][a-zA-Z0-9_-]*:\s*$/gm);
  return jobIdMatches?.length ?? 0;
}

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

  it.each(workflowPaths)('%s has a timeout-minutes for every job', (workflowPath) => {
    const workflow = readFileSync(workflowPath, 'utf8');

    const jobCount = countJobIds(workflow);
    // Accept quoted ('180') and unquoted (180) YAML scalars so the guard does
    // not silently pass a future workflow that quotes the number. The CI node
    // version guard uses the same convention.
    const timeoutCount = (workflow.match(/^\s*timeout-minutes:\s*['"]?\d+['"]?\s*$/gm) ?? [])
      .length;

    // Require one declaration per job. A workflow-level `timeout-minutes`
    // counts as one declaration, so a workflow that relies on it for N jobs
    // still needs N declarations — either N job-level entries or 1
    // workflow-level plus N-1 job-level entries. Anything weaker lets a job
    // inherit GitHub's 6-hour default, which is the bug this guard exists
    // to catch. Forcing the explicit form makes regressions visible: if
    // someone removes the workflow-level default, the next missing job-level
    // entry fails the test, instead of producing a silent 6-hour hang.
    expect(
      timeoutCount,
      `${workflowPath} declares ${jobCount} job(s) but only ${timeoutCount} timeout-minutes; ` +
        `each job needs its own timeout-minutes (a workflow-level default alone does not count for every job).`,
    ).toBeGreaterThanOrEqual(jobCount);
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
      // first to fire. Accepts both quoted ('180') and unquoted (180) YAML
      // scalars, matching the per-job coverage test above.
      const declaredValues = [
        ...workflow.matchAll(/^\s*timeout-minutes:\s*['"]?(\d+)['"]?\s*$/gm),
      ].map((match) => Number(match[1]));

      expect(declaredValues.length).toBeGreaterThan(0);
      for (const value of declaredValues) {
        expect(value).toBeGreaterThanOrEqual(minimum);
      }
    },
  );
});
