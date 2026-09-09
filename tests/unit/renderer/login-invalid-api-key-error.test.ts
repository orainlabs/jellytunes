/**
 * ORAIN-0687: Tests for the error message shown when an invalid API key
 * results in an empty user list.
 *
 * Before fix: "Could not identify user. Please select manually."
 *   - Confusing because there IS no manual selector in this scenario
 *   - Copies copy from UserSelectorScreen which DOES offer a selector
 *
 * After fix: Error message should point to the real problem (API key)
 * and NOT imply a selector exists.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';

// The message currently in UserSelectorScreen (DOES have a selector)
const USER_SELECTOR_MESSAGE =
  'Could not automatically identify your account. Please select which Jellyfin user you want to use for sync.';

// Expected fixed message after ORAIN-0687: points to the real problem (API key)
const EXPECTED_FIXED_MESSAGE = 'Could not authenticate. Check your API key and try again.';

describe('ORAIN-0687: invalid API key error message', () => {
  /**
   * Read the actual error message set in useJellyfinConnection.ts
   * when userList is empty after an auth attempt (line ~298).
   *
   * We do NOT define the expected value inline in the hook — that would
   * make the test always pass. Instead we read the source and verify
   * it matches the fixed copy.
   */
  function getActualErrorMessageFromSource(): string | null {
    const hookPath = resolve(__dirname, '../../../src/renderer/src/hooks/useJellyfinConnection.ts');
    const content = readFileSync(hookPath, 'utf8');

    // Find the error message in the userList.length === 0 branch.
    // Context: lines 284-300 have the structure:
    //   const userList = await fetchUserList(...)
    //   if (userList.length > 0) { ... return false; }
    //   setState(..., error: 'message')
    //   return false;
    const lines = content.split('\n');
    let foundUserListCheck = false;
    let foundLengthGreaterThanZero = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Detect the fetchUserList call
      if (line.includes('fetchUserList(normalizedUrl, apiKey)')) {
        foundUserListCheck = true;
        continue;
      }

      // Skip the "length > 0" block
      if (foundUserListCheck && line.includes('userList.length > 0')) {
        foundLengthGreaterThanZero = true;
        continue;
      }

      // After the >0 block ends (return false;}), look for the error assignment
      if (foundLengthGreaterThanZero && (line.includes("error: '") || line.includes('error: "'))) {
        // Extract the string value between quotes using regex
        const match = line.match(/error:\s*['"]([^'"]+)['"]/);
        if (match) {
          return match[1];
        }
      }
    }
    return null;
  }

  it('should not contain "select manually" language in the empty-userList error', () => {
    const actualMessage = getActualErrorMessageFromSource();
    expect(actualMessage).not.toBeNull();
    expect(actualMessage).not.toMatch(/select manually/i);
  });

  it('should not imply that a user selector exists when userList is empty', () => {
    const actualMessage = getActualErrorMessageFromSource();
    expect(actualMessage).not.toBeNull();
    expect(actualMessage).not.toMatch(/please select/i);
  });

  it('should point to the real problem (API key authentication)', () => {
    const actualMessage = getActualErrorMessageFromSource();
    expect(actualMessage).not.toBeNull();
    expect(actualMessage).toMatch(/API key/i);
  });

  it('should be distinct from the UserSelectorScreen prompt', () => {
    const actualMessage = getActualErrorMessageFromSource();
    expect(actualMessage).not.toBeNull();
    expect(actualMessage).not.toBe(USER_SELECTOR_MESSAGE);
    expect(actualMessage).not.toContain('automatically identify');
    expect(actualMessage).not.toContain('select which');
  });

  it('should match the fixed message from ORAIN-0687', () => {
    const actualMessage = getActualErrorMessageFromSource();
    expect(actualMessage).toBe(EXPECTED_FIXED_MESSAGE);
  });
});
