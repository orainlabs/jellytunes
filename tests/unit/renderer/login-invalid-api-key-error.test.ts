/**
 * ORAIN-0687: verifies the error message shown when an invalid API key
 * results in an empty user list.
 *
 * Before fix: "Could not identify user. Please select manually."
 *   - Confusing because there IS no manual selector in this scenario
 *   - Copied copy from UserSelectorScreen which DOES offer a selector
 *
 * After fix: message correctly points to the API key as the likely cause.
 *
 * Behavioral coverage of the userList===0 branch lives in
 * useJellyfinConnection.test.tsx.
 */
import { describe, it, expect } from 'vitest';
import { INVALID_API_KEY_ERROR } from '../../../src/renderer/src/hooks/useJellyfinConnection';

// The message used in UserSelectorScreen (DOES offer a selector)
const USER_SELECTOR_MESSAGE =
  'Could not automatically identify your account. Please select which Jellyfin user you want to use for sync.';

describe('ORAIN-0687: invalid API key error message', () => {
  it('does not contain "select manually" language', () => {
    expect(INVALID_API_KEY_ERROR).not.toMatch(/select manually/i);
  });

  it('does not imply a user selector exists', () => {
    // No "please select", "choose", "pick", etc. — there is no selector here.
    expect(INVALID_API_KEY_ERROR).not.toMatch(/\b(please|select)\b/i);
  });

  it('points to the API key as the problem', () => {
    expect(INVALID_API_KEY_ERROR).toMatch(/API key/i);
  });

  it('is textually distinct from the UserSelectorScreen prompt', () => {
    expect(INVALID_API_KEY_ERROR).not.toBe(USER_SELECTOR_MESSAGE);
    expect(INVALID_API_KEY_ERROR).not.toMatch(/select\b.*(manually|please|which)/i);
  });

  it('has the fixed copy defined in ORAIN-0687', () => {
    expect(INVALID_API_KEY_ERROR).toBe('Could not authenticate. Check your API key and try again.');
  });
});
