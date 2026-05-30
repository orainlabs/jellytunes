/**
 * Exhaustive switch helper for TypeScript discriminated unions.
 *
 * When all cases of a switch are handled, TypeScript narrows the remaining type
 * to `never`. Calling assertExhaustive with that `never` value is a compile-time
 * verification that the switch is exhaustive. If a new case is added to the union
 * but the switch is not updated, TypeScript will report a compile error.
 *
 * @example
 * ```typescript
 * type LibraryTab = 'artists' | 'albums' | 'playlists';
 *
 * function getItemType(tab: LibraryTab): string {
 *   switch (tab) {
 *     case 'artists': return 'artist';
 *     case 'albums': return 'album';
 *     case 'playlists': return 'playlist';
 *     default:
 *       // If switch is exhaustive, `tab` is `never` here.
 *       // If a new tab is added without updating this switch,
 *       // TypeScript will error: Argument of type 'newTab' is not assignable to 'never'.
 *       return assertExhaustive(tab);
 *   }
 * }
 * ```
 *
 * @param value - The narrowed `never` value from an exhaustive switch
 * @param message - Optional custom error message
 * @returns never (throws)
 */
export function assertExhaustive(value: never, message?: string): never {
  throw new Error(message ?? `Unhandled case: ${JSON.stringify(value)}`);
}
