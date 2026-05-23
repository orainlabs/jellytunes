/**
 * FFmpeg path resolution for packaged Electron apps.
 *
 * When packaged, node_modules end up inside app.asar (a virtual archive).
 * The OS cannot spawn executables from inside .asar files, so we rewrite
 * any path that contains "app.asar/" to "app.asar.unpacked/".
 *
 * The asarUnpack config in package.json must also include the ffmpeg-installer
 * glob so the binary is actually extracted to app.asar.unpacked at build time.
 */

export function rewriteAsarPath(p: string): string {
  // Already points at unpacked location — nothing to do.
  if (p.includes(UNPACKED_SUFFIX)) return p;

  if (p.includes(ASAR_SEGMENT)) {
    return p.replace('app.asar/', 'app.asar.unpacked/');
  }
  if (p.includes(ASAR_WIN_SEGMENT)) {
    return p.replace('app.asar\\', 'app.asar.unpacked\\');
  }
  return p;
}

/** Path separators on any platform */
const ASAR_SEGMENT = 'app.asar' + '/';
const ASAR_WIN_SEGMENT = 'app.asar' + '\\';
const UNPACKED_SUFFIX = 'app.asar.unpacked';

const SYSTEM_FFMPEG_CANDIDATES = [
  '/usr/local/bin/ffmpeg',
  '/opt/homebrew/bin/ffmpeg',
  '/usr/bin/ffmpeg',
  '/opt/local/bin/ffmpeg',
];

/**
 * Resolve the FFmpeg executable path.
 *
 * Priority:
 * 1. @ffmpeg-installer/ffmpeg bundled binary (path rewritten for packaged apps)
 * 2. Known system paths (macOS/Linux)
 * 3. 'ffmpeg' — rely on PATH as last resort
 */
export function resolveFFmpegPath(): string {
  try {
    const installer = require('@ffmpeg-installer/ffmpeg');
    const raw: string = installer.path ?? installer?.default?.path;
    if (raw) return rewriteAsarPath(raw);
  } catch {
    // installer not available; fall through to system paths
  }

  try {
    const { existsSync } = require('fs');
    for (const candidate of SYSTEM_FFMPEG_CANDIDATES) {
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // fs unavailable in unusual environments
  }

  return 'ffmpeg';
}
