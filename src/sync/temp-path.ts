import { tmpdir } from 'os';
import { join } from 'path';
import { ALL_AUDIO_EXTENSIONS } from './audio-formats';

/**
 * Build cross-platform temp file paths for FLAC→MP3 conversion.
 *
 * Uses os.tmpdir() instead of a hardcoded /tmp/ so paths resolve correctly
 * on Windows (C:\Users\<user>\AppData\Local\Temp) as well as macOS/Linux.
 */
export function buildTempPaths(
  trackName: string,
  timestamp: number,
): { sourcePath: string; tempPath: string } {
  const safeName = trackName.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 50);
  return {
    sourcePath: join(tmpdir(), `jellytunes_src_${timestamp}.tmp`),
    tempPath: join(tmpdir(), `jellytunes_${timestamp}_${safeName}.mp3`),
  };
}

/**
 * Build the temp file path used by `convertAndCopy` to buffer the
 * downloaded audio before FFmpeg converts it. ORAIN-0732 AC3/AC4:
 *
 * - AC3: must live under `os.tmpdir()`, NEVER next to the destination
 *   (USB). Reasons: USB wear, crash-leftover visible to music players,
 *   Windows MAX_PATH on FAT32, Snap confinement blocking writes under
 *   $HOME on removable-media plug.
 * - AC4: extension is appended only when `trackFormat` names a known
 *   audio format from `ALL_AUDIO_EXTENSIONS`. Unknown / unsafe / empty
 *   formats yield a bare temp path (no extension) so FFmpeg falls back
 *   to content-sniffing. Comma-separated lists take the first value
 *   per spec.
 */
export function buildConvertTempPath(trackFormat: string | undefined, timestamp: number): string {
  const allowed = new Set<string>(ALL_AUDIO_EXTENSIONS);
  const first = trackFormat?.split(',')[0]?.trim().toLowerCase().replace(/^\./, '') ?? '';
  const ext = first && /^[a-z0-9]+$/.test(first) && allowed.has(first) ? `.${first}` : '';
  const random = Math.random().toString(36).slice(2);
  return join(tmpdir(), `jellytunes_conv_${timestamp}-${random}${ext}`);
}
