import { describe, expect, it } from 'vitest';
import { URL_BUDGET } from './bug-report-excerpt';

describe('URL_BUDGET', () => {
  it('stays under the measured GitHub issue-body URL ceiling with margin', () => {
    // Measured 2026-09-28: GitHub accepts a full
    // `https://github.com/<org>/<repo>/issues/new?body=<...>` URL up to 7061
    // characters (HTTP 302) and rejects 7063 (HTTP 500). URL_BUDGET must stay
    // comfortably below that ceiling.
    const measuredCeiling = 7061;
    expect(URL_BUDGET).toBeLessThan(measuredCeiling * 0.9);
    expect(URL_BUDGET).toBe(6300);
  });
});
