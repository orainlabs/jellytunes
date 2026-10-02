/**
 * Filesystem Operations Module
 *
 * Handles file copying, conversion, and filesystem operations.
 * Pure functions with dependency injection for testing.
 */

import path from 'path';
import type { TrackInfo, DestinationValidation, TrackMetadata, SyncLogger } from './types';
import { resolveFFmpegPath, resolveFFprobePath } from './ffmpeg-path';
import { getJpegFrameType } from './cover-image';

/**
 * Sanitize a metadata string field for safe use in FFmpeg -metadata arguments.
 * Removes control characters, trims whitespace, and enforces a maximum length.
 * Returns empty string for falsy input.
 */
export function sanitizeMetadataField(value: string, maxLength = 500): string {
  if (!value) return '';
  // Remove control characters (0x00-0x1F and 0x7F) — EXCLUDES newlines (LF=0x0A, CR=0x0D)
  // eslint-disable-next-line no-control-regex -- intentional: FFmpeg metadata sanitization
  const cleaned = value.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return cleaned.trim().slice(0, maxLength);
}

/**
 * Sanitize a lyrics field — preserves newlines (LF/CR) for LRC multi-line content.
 * ID3v2 USLT supports multi-line content and FFmpeg handles it correctly.
 * Removes other control characters, trims whitespace, and enforces a maximum length.
 */
export function sanitizeLyricsField(value: string, maxLength = 500): string {
  if (!value) return '';
  // Remove control characters EXCEPT newline (LF=0x0A) and carriage return (CR=0x0D)
  // eslint-disable-next-line no-control-regex -- intentional: FFmpeg metadata sanitization
  const cleaned = value.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return cleaned.trim().slice(0, maxLength);
}

/**
 * Sanitize a numeric metadata field, returning empty string if it does not
 * contain only digits (positive integers only).
 */
export function sanitizeNumericField(value: string): string {
  if (!value) return '';
  return /^\d+$/.test(value) ? value : '';
}

/** FFmpeg protocol URI regex — these must be rejected as output paths */
const FFMPEG_PROTOCOLS =
  /^(pipe:|concat:|http:|https:|rtmp:|ftp:|data:|cache:|async:|crypto:|subfile:|fd:|md5:|tee:|file:)/i;

/**
 * Assert that a path is a safe filesystem path (no FFmpeg protocols, no traversal).
 * Throws if the path could be interpreted as a FFmpeg special protocol, is relative,
 * or contains path traversal segments.
 */
export function assertFilesystemPath(p: string, label = 'output'): void {
  if (!p || typeof p !== 'string') {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (FFMPEG_PROTOCOLS.test(p)) {
    throw new Error(`Invalid ${label} path: FFmpeg protocol URIs are not allowed (got: ${p})`);
  }
  if (!path.isAbsolute(p)) {
    throw new Error(`${label} must be absolute (got: ${p})`);
  }
  // Block path traversal
  const segments = p.replace(/\/+/g, '/').split('/');
  if (segments.some((s) => s === '..')) {
    throw new Error(`${label} must be a local filesystem path (received: "${p}")`);
  }
}

/**
 * Filesystem interface (for dependency injection/testing)
 */
export interface FileSystem {
  /** Check if path exists */
  exists(path: string): Promise<boolean>;

  /** Check if path is a directory */
  isDirectory(path: string): Promise<boolean>;

  /** Create directory recursively */
  mkdir(path: string): Promise<void>;

  /** Copy file */
  copyFile(source: string, destination: string): Promise<void>;

  /** Get file stats */
  stat(path: string): Promise<{ size: number; modified: Date; isFile: boolean }>;

  /** Delete file */
  unlink(path: string): Promise<void>;

  /** Atomically rename a file. Throws if source does not exist or src→dst crosses devices. */
  rename(source: string, destination: string): Promise<void>;

  /** Write file */
  writeFile(path: string, data: Buffer): Promise<void>;

  /** Read file */
  readFile(path: string): Promise<Buffer>;

  /** List directory contents */
  readdir(path: string): Promise<string[]>;

  /** Remove empty directory */
  rmdir(path: string): Promise<void>;

  /** Get available disk space */
  getFreeSpace(path: string): Promise<number>;

  /** Create a readable stream from a file (Node.js Readable) */
  createReadStream(path: string): Promise<NodeJS.ReadableStream>;

  /**
   * Create a writable stream to a file (Node.js Writable). Optional
   * `options.flags` lets callers request exclusive open mode
   * (`'wx'`) to avoid clobbering a stale temp file from a previous
   * crash — ORAIN-0737 AC4.
   */
  createWriteStream(path: string, options?: { flags?: string }): Promise<NodeJS.WritableStream>;

  /** @internal Check if a path is an implicit directory (has children in mock FS) */
  __isImplicitDir?(path: string): boolean;

  /** @internal Register a path as a directory (mock FS only) */
  __setDirectory?(path: string): void;
}

/**
 * Default filesystem implementation using Node.js fs
 */
export function createNodeFileSystem(): FileSystem {
  const fs = require('fs');
  const { stat, mkdir, unlink, writeFile, readFile, readdir } = require('fs/promises');

  return {
    exists: async (path: string) => {
      try {
        await fs.promises.access(path);
        return true;
      } catch {
        return false;
      }
    },

    isDirectory: async (path: string) => {
      try {
        const stats = await stat(path);
        return stats.isDirectory();
      } catch {
        return false;
      }
    },

    mkdir: async (path: string) => {
      await mkdir(path, { recursive: true });
    },

    copyFile: async (source: string, destination: string) => {
      await fs.promises.copyFile(source, destination);
    },

    stat: async (path: string) => {
      const stats = await stat(path);
      return {
        size: stats.size,
        modified: stats.mtime,
        isFile: stats.isFile(),
      };
    },

    unlink: async (path: string) => {
      await unlink(path);
    },

    rename: async (source: string, destination: string) => {
      await fs.promises.rename(source, destination);
    },

    writeFile: async (path: string, data: Buffer) => {
      await writeFile(path, data);
    },

    readFile: async (path: string) => {
      return readFile(path);
    },

    readdir: async (path: string) => {
      return readdir(path);
    },

    rmdir: async (path: string) => {
      const { rmdir } = require('fs/promises');
      await rmdir(path);
    },

    getFreeSpace: async (path: string) => {
      const platform = process.platform;

      try {
        if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
          // fs.statfsSync is a syscall, not a subprocess exec — unlike
          // shelling out to a binary (e.g. `df` on Linux or the Windows
          // volume binary used pre-24H2), it isn't blocked by strict Snap
          // confinement's AppArmor exec policy and doesn't need any
          // external binary on Windows. ORAIN-0725 / GitHub issue #23:
          // replaces the previous `logicaldisk where caption='X:' get
          // freespace` spawn on Windows — that binary is gone in Windows
          // 11 24H2+. Node's statfs implementation fills `bavail` and
          // `bsize` from `GetDiskFreeSpaceExW` on Windows.
          const { statfsSync } = require('fs');
          const stats = statfsSync(path);
          return stats.bavail * stats.bsize;
        }
      } catch {
        // Fallback: assume unlimited space
      }

      return Number.MAX_SAFE_INTEGER;
    },

    createReadStream: async (path: string) => {
      const { createReadStream: nodeCreateReadStream } = require('fs');
      return nodeCreateReadStream(path);
    },

    createWriteStream: async (path: string, options?: { flags?: string }) => {
      const { createWriteStream: nodeCreateWriteStream } = require('fs');
      return nodeCreateWriteStream(path, options);
    },
  };
}

/**
 * Mock filesystem for testing
 */
export function createMockFileSystem(overrides?: Partial<FileSystem>): FileSystem {
  const files = new Map<string, Buffer>();
  const directories = new Set<string>();

  const defaultFs: FileSystem = {
    exists: async (path: string) => files.has(path) || directories.has(path),

    isDirectory: async (path: string) => directories.has(path),

    mkdir: async (path: string) => {
      directories.add(path);
    },

    /** @internal Expose isDirectory logic for callers to trigger re-evaluation */
    __setDirectory: (path: string) => {
      directories.add(path);
    },
    __isImplicitDir: (path: string) => {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      return Array.from(files.keys()).some((f) => f.startsWith(prefix));
    },

    copyFile: async (source: string, destination: string) => {
      const data = files.get(source);
      if (!data) throw new Error(`Source file not found: ${source}`);
      files.set(destination, Buffer.from(data));
    },

    stat: async (path: string) => {
      const data = files.get(path);
      if (!data) throw new Error(`File not found: ${path}`);
      return {
        size: data.length,
        modified: new Date(),
        isFile: true,
      };
    },

    unlink: async (path: string) => {
      files.delete(path);
    },

    rename: async (source: string, destination: string) => {
      const data = files.get(source);
      if (data === undefined) throw new Error(`rename: source not found: ${source}`);
      files.set(destination, Buffer.from(data));
      files.delete(source);
    },

    writeFile: async (path: string, data: Buffer) => {
      files.set(path, Buffer.from(data));
    },

    readFile: async (path: string) => {
      const data = files.get(path);
      if (!data) throw new Error(`File not found: ${path}`);
      return Buffer.from(data);
    },

    readdir: async (path: string) => {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      return Array.from(files.keys())
        .filter((f) => f.startsWith(prefix))
        .map((f) => f.slice(prefix.length).split('/')[0])
        .filter((v, i, a) => a.indexOf(v) === i);
    },

    rmdir: async (path: string) => {
      directories.delete(path);
    },

    getFreeSpace: async () => Number.MAX_SAFE_INTEGER,

    createReadStream: async (path: string) => {
      const data = files.get(path);
      if (!data) throw new Error(`File not found: ${path}`);
      const { Readable } = require('stream');
      return Readable.from(data);
    },

    createWriteStream: async (path: string, _options?: { flags?: string }) => {
      const chunks: Buffer[] = [];
      const { Writable } = require('stream');
      const writeStream = new Writable({
        write(chunk: Buffer, _encoding: string, callback: () => void) {
          chunks.push(chunk);
          callback();
        },
      });
      writeStream.on('finish', () => {
        files.set(path, Buffer.concat(chunks));
      });
      return writeStream;
    },
  };

  // Add helper methods for mock
  const mockFs = { ...defaultFs, ...overrides } as FileSystem & {
    __setFile: (path: string, data: Buffer) => void;
    __getFile: (path: string) => Buffer | undefined;
    __clear: () => void;
  };

  mockFs.__setFile = (path: string, data: Buffer) => files.set(path, data);
  mockFs.__getFile = (path: string) => files.get(path);
  mockFs.__clear = () => {
    files.clear();
    directories.clear();
  };

  return mockFs;
}

/**
 * FFmpeg converter interface
 */
export interface AudioConverter {
  /** Convert audio file to MP3 */
  convertToMp3(
    input: string,
    output: string,
    bitrate: '128k' | '192k' | '320k',
  ): Promise<{ success: boolean; error?: string }>;

  /**
   * Convert audio file at the given path to MP3 via FFmpeg `-i file:<path>`.
   * The path is required (no streaming): FFmpeg can then seek, sniff the
   * original container, and accept inputs that fail or come out empty over
   * stdin (e.g. M4A with moov at end, MP3 with junk header).
   */
  convertStreamToMp3(
    inputPath: string,
    output: string,
    bitrate: '128k' | '192k' | '320k',
  ): Promise<{ success: boolean; error?: string }>;

  /**
   * Convert audio file at the given path to MP3 with metadata and optional
   * cover art embed. The path is passed to FFmpeg as `-i file:<path>` — see
   * ORAIN-0732.
   */
  convertStreamToMp3WithMeta(
    inputPath: string,
    output: string,
    bitrate: '128k' | '192k' | '320k',
    metadata: TrackMetadata,
    embedCover?: Buffer,
  ): Promise<{ success: boolean; error?: string }>;

  /** Tag an existing audio file (passthrough, no re-encoding) with metadata and optional cover art */
  tagFile(
    inputPath: string,
    outputPath: string,
    metadata: TrackMetadata,
    embedCover?: Buffer,
  ): Promise<{ success: boolean; error?: string }>;

  /** Read all metadata tags from an audio file using ffprobe */
  readFileMetadata(filePath: string): Promise<Record<string, string>>;

  /** Check if FFmpeg is available */
  isAvailable(): Promise<boolean>;

  /** Embed lyrics into an audio file (format-specific) */
  embedLyrics(
    inputPath: string,
    outputPath: string,
    lyrics: string,
    format: string,
  ): Promise<{ success: boolean; error?: string }>;

  /**
   * Strip embedded cover art from an audio file using FFmpeg.
   * Always runs ffmpeg -vn -c copy (no-op for files without cover art).
   * Returns { success: true } if stripping succeeded or file had no cover.
   */
  stripCoverArt(
    inputPath: string,
    outputPath: string,
  ): Promise<{ success: boolean; error?: string }>;

  /** Embed ReplayGain tags into an audio file (format-specific) */
  embedReplayGain(
    inputPath: string,
    outputPath: string,
    replayGain: { trackGain: string; trackPeak: string },
    format: string,
  ): Promise<{ success: boolean; error?: string }>;
}

/**
 * Move a file from src to dest, handling cross-device boundaries (EXDEV).
 * `fs.renameSync` is atomic but fails with EXDEV when src and dest are on different
 * devices (e.g. macOS temp dir → USB drive). Falls back to copy + unlink in that case.
 */
function moveFileSync(src: string, dest: string): void {
  const fs = require('fs');
  try {
    fs.renameSync(src, dest);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EXDEV') {
      // Cross-device rename — copy then remove source
      fs.copyFileSync(src, dest);
      try {
        fs.unlinkSync(src);
      } catch {
        /* best-effort cleanup — dest already written, don't fail */
      }
    } else {
      throw err;
    }
  }
}

/**
 * Extract the last non-empty line of FFmpeg's stderr, truncated to
 * `maxLength` characters. The result is meant for user-facing error
 * messages; the full stderr is still logged via the SyncLogger so nothing
 * is lost for diagnostics.
 *
 * If `stderr` is empty or contains only whitespace, returns `undefined` so
 * the caller can fall back to a plain exit-code message.
 */
export function lastFFmpegError(stderr: string, maxLength = 200): string | undefined {
  if (!stderr) return undefined;
  // Split on either LF or CRLF, drop trailing blanks.
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return undefined;
  const last = lines[lines.length - 1];
  return last.length > maxLength ? last.slice(0, maxLength) : last;
}

/**
 * Build the user-facing error message for an FFmpeg failure. Prefixes the
 * exit code and, when stderr has a non-empty trailing line, appends that
 * line so the "Sync failed" popup can show what FFmpeg actually complained
 * about (e.g. "No such file or directory").
 *
 * ORAIN-0752 AC4: the FFmpeg stderr tail may contain an absolute path
 * (POSIX `/…`, Windows `C:\` or `C:/`, UNC `\\server\share`) — typically
 * the temp file FFmpeg could not open. The user-facing SyncError.message
 * must never leak an absolute path. The scrub anchors at the path-start
 * (`/` or `\`, optionally preceded by a Windows drive letter) and
 * consumes subsequent segments that may themselves contain whitespace
 * (e.g. `C:\Program Files\…`, `C:\Users\John Doe\…`); only `\` and `/`
 * segment boundaries are required. Reuses the same regex shape as the
 * download-error path in `sync-core.ts:1842` so the two error sources
 * converge on `<path>` substitution.
 */
export function ffmpegErrorMessage(code: number, stderr: string): string {
  const rawTail = lastFFmpegError(stderr);
  // ORAIN-0767 AC2: the previous scrub anchored at any `/` or `\` and
  // greedily consumed bracketed-hex prefixes like `[out#0/mp3 @ 0x…]`
  // because the `/` inside `[out#0/mp3 @ 0x...]` was treated as a path
  // start. Rewrite the scrub so it only matches a path-start that is
  // either:
  //   - at the start of the string, OR
  //   - preceded by whitespace, OR
  //   - a Windows drive letter (`C:` immediately before).
  // The old "match anywhere `/` or `\`" semantics is what produced the
  // regression: `[out#0/mp3` contained `/` and the scrub ate the prefix.
  //
  // We then KEEP the ORAIN-0752 AC4 segment character class
  // (`[^\\/:"']` + whitespace tolerated) so `C:\Program Files\…` still
  // collapses to a single `<path>`.
  //
  // Implementation: split into two passes. First pass replaces drive-
  // letter paths (`C:\…`, `C:/…`, `\\server\share\…`). Second pass
  // replaces POSIX-style `/…` paths but only at start-of-string or
  // after whitespace. We anchor the second pass with a regex that
  // consumes the boundary character into the match so the substitution
  // preserves any trailing whitespace that follows.
  if (!rawTail) {
    return `FFmpeg exited with code ${code}`;
  }
  let scrubbed = rawTail;
  // Drive-letter or UNC path: matches anywhere in the string because
  // the `C:` / `\\` prefix is itself a path signal that cannot occur in
  // the middle of a token like `[out#0/mp3`. `C:` (Windows) and `\\`
  // (UNC) are unambiguous path starts.
  scrubbed = scrubbed.replace(
    /(?:[A-Za-z]:[\\/][^\\/:"']*(?:[\\/][^\\/:"']*)*|\\\\[^\\/:"']*(?:[\\/][^\\/:"']*)*)/g,
    '<path>',
  );
  // POSIX absolute path: anchor at start-of-string OR after whitespace.
  // We rebuild the boundary character back so we don't lose it. The
  // trailing segment matcher consumes whitespace via `[^\\/:"']` so
  // `Program Files`-style paths collapse to one `<path>`.
  scrubbed = scrubbed.replace(
    /(^|\s)(\/[^\\/:"']*(?:[\\/][^\\/:"']*)*)/g,
    (_match, boundary) => `${boundary}<path>`,
  );
  // ORAIN-0767 AC2 explicit: the user-facing message must never be ONLY
  // `<path>` (the spec is explicit on this point). If the scrub
  // collapsed the tail to just `<path>` we fall back to a generic
  // message that names FFmpeg but does not pretend to know more than we
  // do.
  // If the scrub collapsed the tail to just `<path>`, fall back to a
  // generic message that names FFmpeg but does not pretend we know
  // more than we do.
  if (!scrubbed || scrubbed.trim() === '<path>') {
    return `FFmpeg exited with code ${code}`;
  }
  return `FFmpeg exited with code ${code}: ${scrubbed}`;
}

/**
 * Strip a leading `Download failed:` prefix from a message that was
 * already prefixed by the throw site (e.g. `sync-api.ts:670`). The catch
 * site in `sync-core.ts` then prepends the prefix exactly once, no
 * matter who threw. Used by ORAIN-0767 AC1 to fix the
 * "Download failed: Download failed: 404 Not Found" double-prefix.
 */
export function syncErrorMessage(message: string): string {
  return message.replace(/^Download failed:\s*/, '');
}

export function createFFmpegConverter(logger?: SyncLogger): AudioConverter {
  const ffmpegPath = resolveFFmpegPath();
  const ffprobePath = resolveFFprobePath();

  return {
    convertToMp3: async (input, output, bitrate) => {
      assertFilesystemPath(output);
      const { spawn } = require('child_process');

      return new Promise((resolve) => {
        const args = [
          '-i',
          input,
          '-vn', // skip video/cover-art streams
          '-ab',
          bitrate,
          '-ar',
          '44100',
          '-ac',
          '2',
          '-y', // overwrite output
          output,
        ];

        // stdio: ['ignore', 'ignore', 'pipe'] — capture stderr so the popup can
        // surface the real FFmpeg failure cause (e.g. "No such file or directory")
        // instead of just the exit code. Mirrors the pattern used by tagFile,
        // stripCoverArt, embedLyrics, embedReplayGain and convertStreamToMp3*.
        const process = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

        let stderr = '';
        process.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        process.on('error', (err: Error) => {
          resolve({
            success: false,
            error: `FFmpeg error: ${err.message}`,
          });
        });

        process.on('close', (code: number) => {
          if (code !== 0) {
            logger?.error(
              `[sync-files] convertToMp3 FFmpeg failed for ${output}: code=${code}\nargs: ${args.join(' ')}\nstderr: ${stderr}`,
            );
          }
          resolve({
            success: code === 0,
            error: code !== 0 ? ffmpegErrorMessage(code, stderr) : undefined,
          });
        });
      });
    },

    convertStreamToMp3: async (inputPath, output, bitrate) => {
      assertFilesystemPath(inputPath, 'inputPath');
      assertFilesystemPath(output);
      const { spawn } = require('child_process');

      return new Promise((resolve) => {
        // ORAIN-0732: read input from disk via -i file:<path>. The file:
        // prefix FORCES FFmpeg to treat the argument as a file URI, which
        // is the opposite of "stop parsing as protocol" — without it, a path
        // containing `:` (Windows drive letters like `C:\...`, or a track
        // titled `Foo: Bar`) would be parsed as an FFmpeg protocol like
        // `c` or `data` and the spawn would fail with ENOENT or hang.
        const args = [
          '-i',
          `file:${inputPath}`,
          '-vn',
          '-ab',
          bitrate,
          '-ar',
          '44100',
          '-ac',
          '2',
          '-y',
          output,
        ];

        const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

        let stderr = '';
        proc.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        proc.on('error', (err: Error) => {
          resolve({ success: false, error: `FFmpeg error: ${err.message}` });
        });

        proc.on('close', (code: number) => {
          if (code !== 0) {
            logger?.error(
              `[sync-files] convertStreamToMp3 FFmpeg failed for ${output}: code=${code}\nargs: ${args.join(' ')}\nstderr: ${stderr}`,
            );
          }
          resolve({
            success: code === 0,
            error: code !== 0 ? ffmpegErrorMessage(code, stderr) : undefined,
          });
        });
      });
    },

    convertStreamToMp3WithMeta: async (inputPath, output, bitrate, metadata, embedCover) => {
      assertFilesystemPath(inputPath, 'inputPath');
      assertFilesystemPath(output);
      const { spawn } = require('child_process');
      const fs = require('fs');
      const os = require('os');

      return new Promise((resolve) => {
        // Build args: inputs first, then encoding params, then metadata, then output.
        // FFmpeg requires all -i / -map / -vn flags to appear after their input, not before.
        const args: string[] = [];
        let coverTempPath: string | undefined;

        // Input 0: audio from disk (path). The file: prefix FORCES FFmpeg
        // to treat the argument as a file URI; without it a path containing
        // `:` (e.g. Windows drive letters) would be parsed as an FFmpeg
        // protocol — ORAIN-0732.
        args.push('-i', `file:${inputPath}`);

        // Input 1: cover art image (only when embedding)
        if (embedCover) {
          coverTempPath = `${os.tmpdir()}/jt-cover-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
          fs.writeFileSync(coverTempPath, embedCover);
          args.push('-i', coverTempPath);
        }

        // Stream mapping and encoding — use -vn unless we have a video stream from cover art
        if (!embedCover) args.push('-vn');
        args.push('-ab', bitrate, '-ar', '44100', '-ac', '2');

        // Map streams: audio from input 0 (the temp file), video from cover (input 1)
        if (embedCover) {
          args.push('-map', '0:a', '-map', '1:v', '-disposition:v', 'attached_pic');
          // ORAIN-0736: pick -c:v so the cover stays the size Jellyfin returned
          // instead of being silently re-encoded by the MP3 muxer to PNG (which
          // costs ~40% of file size and isn't accepted by most car radios).
          // Baseline/extended JPEG → copy; otherwise re-encode to mjpeg.
          const coverCodec = isBaselineOrExtendedJpeg(embedCover) ? 'copy' : 'mjpeg';
          args.push('-c:v', coverCodec);
        }

        // Metadata flags — all fields sanitized before passing to FFmpeg
        if (metadata.title)
          args.push('-metadata', `title=${sanitizeMetadataField(metadata.title)}`);
        if (metadata.artist)
          args.push('-metadata', `artist=${sanitizeMetadataField(metadata.artist)}`);
        if (metadata.albumArtist)
          args.push('-metadata', `album_artist=${sanitizeMetadataField(metadata.albumArtist)}`);
        if (metadata.album)
          args.push('-metadata', `album=${sanitizeMetadataField(metadata.album)}`);
        const year = sanitizeNumericField(metadata.year ?? '');
        if (year) args.push('-metadata', `date=${year}`);
        const track = sanitizeNumericField(metadata.trackNumber ?? '');
        if (track) args.push('-metadata', `track=${track}`);
        const disc = sanitizeNumericField(metadata.discNumber ?? '');
        if (disc) args.push('-metadata', `disc=${disc}`);
        if (metadata.genres?.length)
          args.push(
            '-metadata',
            `genre=${metadata.genres.map((g) => sanitizeMetadataField(g)).join(';')}`,
          );
        if (metadata.composer)
          args.push('-metadata', `composer=${sanitizeMetadataField(metadata.composer)}`);
        if (metadata.isrc) args.push('-metadata', `isrc=${sanitizeMetadataField(metadata.isrc)}`);
        if (metadata.copyright)
          args.push('-metadata', `copyright=${sanitizeMetadataField(metadata.copyright)}`);
        if (metadata.comment)
          args.push('-metadata', `comment=${sanitizeMetadataField(metadata.comment)}`);

        args.push('-y', output);

        // stdio: ['ignore', 'pipe', 'pipe'] — stdin is no longer piped (we
        // pass the file by path). stderr/stdout remain pipe-able for the
        // diagnostic logging and error reporting in ORAIN-0726.
        const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

        let stderr = '';
        proc.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        proc.on('error', (err: Error) => {
          if (coverTempPath)
            try {
              fs.unlinkSync(coverTempPath);
            } catch {
              /* ignore */
            }
          resolve({ success: false, error: `FFmpeg error: ${err.message}` });
        });

        proc.on('close', (code: number) => {
          if (coverTempPath)
            try {
              fs.unlinkSync(coverTempPath);
            } catch {
              /* ignore */
            }
          if (code !== 0) {
            logger?.error(
              `[sync-files] FFmpeg failed for ${output}: code=${code}\nargs: ${args.join(' ')}\nstderr: ${stderr}`,
            );
          }
          resolve({
            success: code === 0,
            error: code !== 0 ? ffmpegErrorMessage(code, stderr) : undefined,
          });
        });
      });
    },

    tagFile: async (inputPath, outputPath, metadata, embedCover) => {
      assertFilesystemPath(inputPath, 'inputPath');
      assertFilesystemPath(outputPath, 'outputPath');
      const { spawn } = require('child_process');
      const fs = require('fs');
      const os = require('os');
      const path = require('path');

      return new Promise((resolve) => {
        // FFmpeg cannot edit files in-place. When input === output, write to a
        // temp file first, then atomically replace the original.
        const useTempOutput = inputPath === outputPath;
        const finalOutputPath = outputPath;
        // Use the same extension as the original file so FFmpeg recognizes the format
        const ext = path.extname(inputPath);
        const tempOutputPath = useTempOutput
          ? `${os.tmpdir()}/jt-tag-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
          : outputPath;

        // Build complete args array BEFORE spawning — all inputs and flags before output
        const args: string[] = ['-i', inputPath];

        // Handle cover art via temp file — insert immediately after first -i
        let coverTempPath: string | undefined;
        if (embedCover) {
          coverTempPath = `${os.tmpdir()}/jt-cover-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
          fs.writeFileSync(coverTempPath, embedCover);
          args.push(
            '-i',
            coverTempPath,
            '-map',
            '0:a',
            '-map',
            '1:v',
            '-disposition:v',
            'attached_pic',
          );
          // ORAIN-0736: tagFile already runs -c copy for the audio stream; the
          // cover still needs an explicit codec choice or FFmpeg's MP3 muxer
          // will pick PNG (its default). Copy the bytes for baseline/extended
          // JPEG, otherwise re-encode to mjpeg so the result is still a JPEG.
          const coverCodec = isBaselineOrExtendedJpeg(embedCover) ? 'copy' : 'mjpeg';
          args.push('-c:v', coverCodec);
        }

        args.push('-c', 'copy', '-y');

        // Metadata flags — must appear AFTER all inputs but before output path
        if (metadata.title)
          args.push('-metadata', `title=${sanitizeMetadataField(metadata.title)}`);
        if (metadata.artist)
          args.push('-metadata', `artist=${sanitizeMetadataField(metadata.artist)}`);
        if (metadata.albumArtist)
          args.push('-metadata', `album_artist=${sanitizeMetadataField(metadata.albumArtist)}`);
        if (metadata.album)
          args.push('-metadata', `album=${sanitizeMetadataField(metadata.album)}`);
        const year = sanitizeNumericField(metadata.year ?? '');
        if (year) args.push('-metadata', `date=${year}`);
        const track = sanitizeNumericField(metadata.trackNumber ?? '');
        if (track) args.push('-metadata', `track=${track}`);
        const disc = sanitizeNumericField(metadata.discNumber ?? '');
        if (disc) args.push('-metadata', `disc=${disc}`);
        if (metadata.genres?.length)
          args.push(
            '-metadata',
            `genre=${metadata.genres.map((g) => sanitizeMetadataField(g)).join(';')}`,
          );
        if (metadata.composer)
          args.push('-metadata', `composer=${sanitizeMetadataField(metadata.composer)}`);
        if (metadata.isrc) args.push('-metadata', `isrc=${sanitizeMetadataField(metadata.isrc)}`);
        if (metadata.copyright)
          args.push('-metadata', `copyright=${sanitizeMetadataField(metadata.copyright)}`);
        if (metadata.comment)
          args.push('-metadata', `comment=${sanitizeMetadataField(metadata.comment)}`);

        args.push(tempOutputPath);

        const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });

        let stderr = '';
        proc.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        proc.on('error', (err: Error) => {
          if (coverTempPath)
            try {
              fs.unlinkSync(coverTempPath);
            } catch {
              /* ignore */
            }
          resolve({ success: false, error: `FFmpeg error: ${err.message}` });
        });

        proc.on('close', (code: number) => {
          if (coverTempPath)
            try {
              fs.unlinkSync(coverTempPath);
            } catch {
              /* ignore */
            }
          if (code === 0 && useTempOutput) {
            // Move temp file to final destination (handles cross-device via copy+unlink)
            try {
              fs.unlinkSync(finalOutputPath);
              moveFileSync(tempOutputPath, finalOutputPath);
            } catch (renameErr) {
              logger?.error(
                `[sync-files] tagFile failed to replace ${finalOutputPath}: ${renameErr}`,
              );
              try {
                fs.unlinkSync(tempOutputPath);
              } catch {
                /* ignore */
              }
              resolve({ success: false, error: `Failed to replace file: ${renameErr}` });
              return;
            }
          }
          if (code !== 0) {
            if (useTempOutput)
              try {
                fs.unlinkSync(tempOutputPath);
              } catch {
                /* ignore */
              }
            logger?.error(
              `[sync-files] tagFile FFmpeg failed for ${outputPath}: code=${code}\nargs: ${args.join(' ')}\nstderr: ${stderr}`,
            );
          }
          resolve({
            success: code === 0,
            error: code !== 0 ? ffmpegErrorMessage(code, stderr) : undefined,
          });
        });
      });
    },

    isAvailable: async () => {
      const { spawnSync } = require('child_process');
      try {
        const check = spawnSync(ffmpegPath, ['-version'], { stdio: 'ignore', timeout: 5000 });
        return !check.error && check.status === 0;
      } catch {
        return false;
      }
    },

    readFileMetadata: async (filePath: string) => {
      const { spawn } = require('child_process');

      return new Promise((resolve) => {
        const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath];

        const proc = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'ignore'] });

        let stdout = '';
        proc.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });

        proc.on('error', () => {
          resolve({});
        });
        proc.on('close', () => {
          try {
            const parsed = JSON.parse(stdout);
            const tags = parsed.format?.tags ?? {};
            // Normalize key names to lowercase for consistent lookup
            const normalized: Record<string, string> = {};
            for (const [k, v] of Object.entries(tags)) {
              normalized[k.toLowerCase()] = String(v);
            }
            resolve(normalized);
          } catch {
            resolve({});
          }
        });
      });
    },

    embedLyrics: async (inputPath, outputPath, lyrics, format) => {
      assertFilesystemPath(inputPath, 'inputPath');
      assertFilesystemPath(outputPath, 'outputPath');
      const { spawn } = require('child_process');
      const fs = require('fs');
      const os = require('os');
      const path = require('path');

      return new Promise((resolve) => {
        // Use explicit format parameter if provided, otherwise derive from input path
        const ext = format
          ? `.${format.replace(/^\./, '')}`
          : path.extname(inputPath).toLowerCase();
        const useTempOutput = inputPath === outputPath;
        const tempOutputPath = useTempOutput
          ? `${os.tmpdir()}/jt-lyrics-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
          : outputPath;

        const args: string[] = ['-i', inputPath];

        // Format-specific metadata tag for lyrics:
        // - MP3: Use USLT (unsynchronized lyrics) via -metadata lyrics=... (FFmpeg cannot write SYLT)
        // - FLAC: LYRICS (Vorbis Comment)
        // - M4A/AAC: ©lyr
        const safeLyrics = sanitizeLyricsField(lyrics, 5000);
        if (ext === '.mp3') {
          // MP3 uses USLT (unsynchronized text lyrics) via -metadata lyrics=...
          args.push('-metadata', `lyrics=${safeLyrics}`);
        } else if (ext === '.flac') {
          // FLAC uses LYRICS Vorbis Comment tag
          args.push('-metadata', `lyrics=${safeLyrics}`);
        } else if (ext === '.m4a' || ext === '.aac') {
          // M4A/AAC: FFmpeg maps `-metadata lyrics=...` to the ©lyr (iTunes) atom.
          // The raw atom name `©lyr=` is silently ignored — must use `lyrics` key.
          args.push('-metadata', `lyrics=${safeLyrics}`);
        } else {
          // Generic fallback for other formats
          args.push('-metadata', `lyrics=${safeLyrics}`);
        }

        args.push('-c', 'copy', '-y', tempOutputPath);

        let stderrOutput = '';
        const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });

        proc.stderr.on('data', (chunk: Buffer) => {
          stderrOutput += chunk.toString();
        });

        const safeLog = logger ?? { warn: (msg: string) => console.warn(msg) };
        proc.on('error', (err: Error) => {
          if (useTempOutput)
            try {
              fs.unlinkSync(tempOutputPath);
            } catch (cleanupError) {
              // Log but don't fail - primary operation already failed
              safeLog.warn(`[embedLyrics] Failed to clean up temp file: ${cleanupError}`);
            }
          resolve({ success: false, error: `FFmpeg error: ${err.message}` });
        });

        proc.on('close', (code: number) => {
          if (code === 0) {
            try {
              // Only unlink original if we wrote to a different temp path
              // When useTempOutput is true: tempOutputPath is different (the temp file), keep original
              // When useTempOutput is false: outputPath IS the temp path, nothing to unlink
              if (!useTempOutput && outputPath !== tempOutputPath) {
                fs.unlinkSync(outputPath);
              }
              moveFileSync(tempOutputPath, outputPath);
            } catch (cleanupError) {
              resolve({ success: false, error: `Failed to finalize lyrics: ${cleanupError}` });
              return;
            }
            resolve({ success: true });
            return;
          }
          if (code !== 0) {
            if (useTempOutput)
              try {
                fs.unlinkSync(tempOutputPath);
              } catch (cleanupError) {
                // Log but don't block the error response
                safeLog.warn(`[embedLyrics] Failed to clean up temp file: ${cleanupError}`);
              }
            resolve({
              success: false,
              error: code !== 0 ? ffmpegErrorMessage(code, stderrOutput) : undefined,
            });
          }
        });
      });
    },

    stripCoverArt: async (inputPath, outputPath) => {
      assertFilesystemPath(inputPath, 'inputPath');
      assertFilesystemPath(outputPath, 'outputPath');
      const { spawn } = require('child_process');
      const fs = require('fs');
      const os = require('os');
      const path = require('path');

      // Always run ffmpeg -vn -c copy (no-op for files without cover art).
      // Previous probe step used ffmpeg with ffprobe flags, causing empty stdout
      // and early return without strip — fixed by removing the probe entirely.
      // FFmpeg cannot edit files in-place: use a temp file when inputPath === outputPath.
      const useTempOutput = inputPath === outputPath;
      const finalOutputPath = outputPath;
      const ext = path.extname(inputPath);
      const tempOutputPath = useTempOutput
        ? `${os.tmpdir()}/jt-strip-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
        : outputPath;

      return new Promise((resolve) => {
        const args = [
          '-i',
          inputPath,
          '-vn', // skip video/cover streams
          '-c',
          'copy', // passthrough audio encoding
          '-y', // overwrite output
          tempOutputPath,
        ];

        const process = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });

        let stderr = '';
        process.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        process.on('error', (err: Error) => {
          if (useTempOutput) {
            try {
              fs.unlinkSync(tempOutputPath);
            } catch (_e) {
              /* non-fatal cleanup */
            }
          }
          resolve({
            success: false,
            error: `FFmpeg strip error: ${err.message}`,
          });
        });

        process.on('close', (code: number) => {
          if (useTempOutput) {
            if (code === 0) {
              try {
                moveFileSync(tempOutputPath, finalOutputPath);
              } catch (renameErr) {
                try {
                  fs.unlinkSync(tempOutputPath);
                } catch (_e) {
                  /* non-fatal cleanup */
                }
                resolve({
                  success: false,
                  error: `Failed to replace file: ${renameErr}`,
                });
                return;
              }
            } else {
              try {
                fs.unlinkSync(tempOutputPath);
              } catch (_e) {
                /* non-fatal cleanup */
              }
            }
          }
          if (code !== 0) {
            logger?.error(
              `[sync-files] stripCoverArt FFmpeg failed for ${outputPath}: code=${code}\nargs: ${args.join(' ')}\nstderr: ${stderr}`,
            );
          }
          resolve({
            success: code === 0,
            error: code !== 0 ? ffmpegErrorMessage(code, stderr) : undefined,
          });
        });
      });
    },

    embedReplayGain: async (inputPath, outputPath, replayGain, format) => {
      assertFilesystemPath(inputPath, 'inputPath');
      assertFilesystemPath(outputPath, 'outputPath');
      const { spawn } = require('child_process');
      const fs = require('fs');
      const os = require('os');
      const path = require('path');

      return new Promise((resolve) => {
        const ext = format
          ? `.${format.replace(/^\./, '')}`
          : path.extname(inputPath).toLowerCase();
        const useTempOutput = inputPath === outputPath;
        const tempOutputPath = useTempOutput
          ? `${os.tmpdir()}/jt-replaygain-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
          : outputPath;

        const args: string[] = ['-i', inputPath];

        // ReplayGain tags are written as metadata for all formats
        // MP3: ID3v2 REPLAYGAIN_TRACK_GAIN / REPLAYGAIN_TRACK_PEAK
        // FLAC: Vorbis Comment REPLAYGAIN_TRACK_GAIN / REPLAYGAIN_TRACK_PEAK
        // M4A: iTunes atom (FFmpeg maps REPLAYGAIN_TRACK_GAIN correctly)
        args.push('-metadata', `REPLAYGAIN_TRACK_GAIN=${replayGain.trackGain}`);
        args.push('-metadata', `REPLAYGAIN_TRACK_PEAK=${replayGain.trackPeak}`);

        args.push('-c', 'copy', '-y', tempOutputPath);

        let stderrOutput = '';
        const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });

        proc.stderr.on('data', (chunk: Buffer) => {
          stderrOutput += chunk.toString();
        });

        proc.on('error', (err: Error) => {
          if (useTempOutput)
            try {
              fs.unlinkSync(tempOutputPath);
            } catch {
              /* ignore */
            }
          resolve({ success: false, error: `FFmpeg error: ${err.message}` });
        });

        proc.on('close', (code: number) => {
          if (code === 0) {
            try {
              if (!useTempOutput && outputPath !== tempOutputPath) {
                fs.unlinkSync(outputPath);
              }
              moveFileSync(tempOutputPath, outputPath);
            } catch (cleanupError) {
              resolve({ success: false, error: `Failed to finalize ReplayGain: ${cleanupError}` });
              return;
            }
            resolve({ success: true });
            return;
          }
          if (useTempOutput)
            try {
              fs.unlinkSync(tempOutputPath);
            } catch {
              /* ignore */
            }
          resolve({
            success: false,
            error: code !== 0 ? ffmpegErrorMessage(code, stderrOutput) : undefined,
          });
        });
      });
    },
  };
}

/**
 * Decide whether the cover bytes can be stream-copied into the MP3. Returns
 * true for JPEG SOF0 (baseline) and SOF1 (extended) — the two forms whose
 * bytes FFmpeg's mjpeg decoder identifies as "mjpeg", which `-c:v copy` can
 * carry verbatim. SOF2 (progressive) is also mjpeg but `-c:v copy` would
 * embed a progressive JPEG that many car readers reject, so we re-encode
 * it (and PNG/WEBP/etc.) to baseline mjpeg via the encoder below.
 *
 * ORAIN-0736: this predicate replaces FFmpeg's default "use the muxer
 * default codec (PNG)" path that bloated embedded covers by ~40 %.
 */
export function isBaselineOrExtendedJpeg(bytes: Buffer): boolean {
  if (!bytes || bytes.length < 4) return false;
  // getJpegFrameType already runs isJpeg (SOI check) and returns
  // 'non-jpeg' for anything that isn't a JPEG, so the predicate collapses
  // to a single classification call.
  const frameType = getJpegFrameType(bytes);
  return frameType === 'baseline' || frameType === 'extended';
}

/**
 * Create mock converter for testing
 */
export function createMockConverter(): AudioConverter {
  return {
    convertToMp3: async () => ({ success: true }),
    convertStreamToMp3: async () => ({ success: true }),
    convertStreamToMp3WithMeta: async () => ({ success: true }),
    tagFile: async () => ({ success: true }),
    readFileMetadata: async () => ({}),
    isAvailable: async () => true,
    embedLyrics: async () => ({ success: true }),
    embedReplayGain: async () => ({ success: true }),
    stripCoverArt: async () => ({ success: true }),
  };
}

/**
 * Validate destination path
 */
export async function validateDestination(
  path: string,
  fs: FileSystem,
): Promise<DestinationValidation> {
  const errors: string[] = [];
  let exists = false;
  let writable = false;
  let freeSpace: number | undefined;

  try {
    exists = await fs.exists(path);

    if (exists) {
      const isDir = await fs.isDirectory(path);
      if (!isDir) {
        errors.push('Path exists but is not a directory');
      } else {
        // Try to check write access by attempting to list
        try {
          await fs.readdir(path);
          writable = true;
        } catch {
          errors.push('Directory is not readable/writable');
        }

        // Try to get free space
        try {
          freeSpace = await fs.getFreeSpace(path);
        } catch {
          // Ignore space check error
        }
      }
    }
  } catch (error) {
    errors.push(`Error checking path: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  return {
    valid: errors.length === 0,
    exists,
    writable,
    freeSpace,
    errors,
  };
}

/**
 * Sanitize filename for filesystem
 */
export function sanitizeFilename(filename: string): string {
  // Remove or replace invalid characters
  return (
    filename
      .replace(/[<>:"/\\|?*]/g, '_')
      // eslint-disable-next-line no-control-regex -- intentional: keep unicode, reject non-printable
      .replace(/[^\x00-\x7F]/g, (c) => c) // Keep unicode characters
      .slice(0, 255)
  ); // Max filename length
}

/**
 * Create unique filename if file exists
 */
export async function getUniqueFilename(
  basePath: string,
  filename: string,
  fs: FileSystem,
): Promise<string> {
  const ext = filename.match(/\.[^.]+$/)?.[0] ?? '';
  const baseName = filename.replace(/\.[^.]+$/, '');

  let finalName = filename;
  let counter = 1;

  while (await fs.exists(`${basePath}/${finalName}`)) {
    finalName = `${baseName} (${counter})${ext}`;
    counter++;
  }

  return finalName;
}

/**
 * Ensure directory exists, creating if necessary
 */
export async function ensureDirectory(path: string, fs: FileSystem): Promise<void> {
  if (!(await fs.exists(path))) {
    await fs.mkdir(path);
  }
}

/**
 * Copy file with progress callback
 */
export async function copyFileWithProgress(
  source: string,
  destination: string,
  fs: FileSystem,
  onProgress?: (bytesCopied: number, totalBytes: number) => void,
): Promise<void> {
  // For now, simple copy - could be enhanced for streaming with progress
  await fs.copyFile(source, destination);

  if (onProgress) {
    const stat = await fs.stat(destination);
    onProgress(stat.size, stat.size);
  }
}

/**
 * Calculate total size of tracks
 */
export function calculateTotalSize(tracks: TrackInfo[]): number {
  return tracks.reduce((sum, track) => sum + (track.size ?? 0), 0);
}

/**
 * Merge original file metadata with Jellyfin metadata.
 * Jellyfin fields take priority; file fields fill holes where Jellyfin has no value.
 * Also normalizes common tag name variations (e.g. album_artist vs albumartist).
 */
export function mergeMetadata(
  fileMeta: Record<string, string>,
  jellyfinMeta: TrackMetadata,
): TrackMetadata {
  // Normalize file tag keys: ffprobe returns lowercase keys but field names vary
  // Map common aliases to standard field names
  const albumArtistAliases = ['album_artist', 'albumartist', 'album artist', 'albumartist'];
  const composerAliases = ['composer', 'composed by', 'writer', 'lyricist'];
  const isrcAliases = ['isrc', 'isrc-code'];
  const copyrightAliases = ['copyright', 'licence', 'license'];
  const commentAliases = ['comment', 'comments', 'description'];

  const getFileVal = (aliases: string[]): string | undefined => {
    for (const a of aliases) {
      const v = fileMeta[a.toLowerCase()];
      if (v) return v;
    }
    return undefined;
  };

  return {
    title: jellyfinMeta.title ?? fileMeta.title,
    artist: jellyfinMeta.artist ?? fileMeta.artist,
    albumArtist: jellyfinMeta.albumArtist ?? getFileVal(albumArtistAliases),
    album: jellyfinMeta.album ?? fileMeta.album,
    year: jellyfinMeta.year ?? fileMeta.date ?? fileMeta.year,
    trackNumber: jellyfinMeta.trackNumber ?? fileMeta.track,
    discNumber: jellyfinMeta.discNumber ?? fileMeta.disc,
    genres: jellyfinMeta.genres?.length
      ? jellyfinMeta.genres
      : fileMeta.genre
        ? [fileMeta.genre]
        : undefined,
    composer: jellyfinMeta.composer ?? getFileVal(composerAliases),
    isrc: jellyfinMeta.isrc ?? getFileVal(isrcAliases),
    copyright: jellyfinMeta.copyright ?? getFileVal(copyrightAliases),
    comment: jellyfinMeta.comment ?? getFileVal(commentAliases),
  };
}

/**
 * Format size for display
 */
export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;

  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }

  return `${size.toFixed(1)} ${units[unit]}`;
}
