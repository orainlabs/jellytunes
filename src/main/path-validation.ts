// ORAIN-0757 AC6: extracted from the inline `isValidPath` in src/main/index.ts.
//
// The predicate now guards sync:start2 BEFORE mkdirSync runs — if a
// renderer-supplied destination path is malformed (relative, null byte,
// bare drive letter), we surface a clear error instead of letting
// mkdirSync throw or fs.statfsSync resolve relative to cwd.
//
// Two checks beyond the original:
//   - bare drive letter without `:` or trailing separator is rejected.
//     This is the same regression class that broke v0.7.1 — `G\` slipped
//     past extractDriveLetter and broke filesystem detection. We don't
//     accept that shape here either, so a renderer that constructs the
//     path with the same bug fails fast in IPC instead of failing at
//     mkdirSync time on the user's machine.
//   - null-byte rejection stays; null bytes can confuse NTFS APIs.

export function isValidPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.includes('\0')) return false;
  // Bare drive letter (e.g. 'G', 'G\\', 'G:') is not a valid absolute path.
  if (/^[A-Za-z]:?$/.test(p) || /^[A-Za-z]:[\\/]$/.test(p)) {
    // 'X:' alone or 'X:' with separator-but-empty-trailing is still wrong.
    // We accept 'X:' followed by another segment (e.g. 'G:\\foo').
    if (!/^[A-Za-z]:[\\/](?!\/).+/.test(p)) return false;
  }
  // Must be absolute: starts with / (unix), X:\ / X:/ (windows), or \\unc\share
  const isAbsolute = p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
  return isAbsolute;
}
