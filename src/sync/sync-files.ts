/**
 * Filesystem Operations Module
 * 
 * Handles file copying, conversion, and filesystem operations.
 * Pure functions with dependency injection for testing.
 */

import path from 'path';
import type { TrackInfo, DestinationValidation, TrackMetadata } from './types';
import { resolveFFmpegPath } from './ffmpeg-path';

/**
 * Sanitize a metadata string field for safe use in FFmpeg -metadata arguments.
 * Removes control characters, trims whitespace, and enforces a maximum length.
 * Returns empty string for falsy input.
 */
export function sanitizeMetadataField(value: string, maxLength = 500): string {
  if (!value) return '';
  // Remove control characters (0x00-0x1F and 0x7F)
  const cleaned = value.replace(/[\x00-\x1F\x7F]/g, '');
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
const FFMPEG_PROTOCOLS = /^(pipe:|concat:|http:|https:|rtmp:|ftp:|data:|cache:|async:|crypto:|subfile:|fd:|md5:|tee:)/i;

/**
 * Assert that a path is a safe filesystem path (not a FFmpeg protocol URI or relative path).
 * Throws if the path could be interpreted as a FFmpeg special protocol or is not absolute.
 */
export function assertFilesystemPath(p: string, label = 'output'): void {
  if (FFMPEG_PROTOCOLS.test(p)) {
    throw new Error(`Invalid ${label} path: FFmpeg protocol URIs are not allowed (got: ${p})`);
  }
  if (!path.isAbsolute(p)) {
    throw new Error(`Invalid ${label} path: must be absolute (got: ${p})`);
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

  /** Create a writable stream to a file (Node.js Writable) */
  createWriteStream(path: string): Promise<NodeJS.WritableStream>;
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
      // Platform-specific implementation — uses spawnSync with arg arrays (no shell injection risk)
      const platform = process.platform;
      const { spawnSync } = require('child_process');

      try {
        if (platform === 'darwin' || platform === 'linux') {
          const result = spawnSync('df', ['-k', path], { encoding: 'utf8' as const });
          const lines = (result.stdout ?? '').trim().split('\n').filter((l: string) => l.trim());
          const lastLine = lines[lines.length - 1] ?? '';
          const parts = lastLine.trim().split(/\s+/);
          if (parts.length >= 4) {
            return parseInt(parts[3]) * 1024; // Convert KB to bytes
          }
        } else if (platform === 'win32') {
          const driveLetter = path.charAt(0);
          const result = spawnSync(
            'wmic',
            ['logicaldisk', 'where', `caption='${driveLetter}:'`, 'get', 'freespace', '/format:csv'],
            { encoding: 'utf8' as const }
          );
          const lines = (result.stdout ?? '').split('\n').filter((l: string) => l.trim() && !l.includes('Node'));
          if (lines.length > 0) {
            const parts = lines[lines.length - 1].split(',');
            return parseInt(parts[1]) || 0;
          }
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

    createWriteStream: async (path: string) => {
      const { createWriteStream: nodeCreateWriteStream } = require('fs');
      return nodeCreateWriteStream(path);
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
        .filter(f => f.startsWith(prefix))
        .map(f => f.slice(prefix.length).split('/')[0])
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

    createWriteStream: async (path: string) => {
      const chunks: Buffer[] = [];
      const { Writable } = require('stream');
      const writeStream = new Writable({
        write(chunk: Buffer, _encoding: string, callback: () => void) {
          chunks.push(chunk);
          callback();
        }
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
    bitrate: '128k' | '192k' | '320k'
  ): Promise<{ success: boolean; error?: string }>;

  /** Convert audio stream (Node.js Readable) to MP3 via FFmpeg stdin */
  convertStreamToMp3(
    input: NodeJS.ReadableStream,
    output: string,
    bitrate: '128k' | '192k' | '320k'
  ): Promise<{ success: boolean; error?: string }>;

  /** Convert audio stream with metadata and optional cover art embeds */
  convertStreamToMp3WithMeta(
    input: NodeJS.ReadableStream,
    output: string,
    bitrate: '128k' | '192k' | '320k',
    metadata: TrackMetadata,
    embedCover?: Buffer
  ): Promise<{ success: boolean; error?: string }>;

  /** Tag an existing audio file (passthrough, no re-encoding) with metadata and optional cover art */
  tagFile(
    inputPath: string,
    outputPath: string,
    metadata: TrackMetadata,
    embedCover?: Buffer
  ): Promise<{ success: boolean; error?: string }>;

  /** Read all metadata tags from an audio file using ffprobe */
  readFileMetadata(
    filePath: string
  ): Promise<Record<string, string>>;

  /** Check if FFmpeg is available */
  isAvailable(): Promise<boolean>;
}

export function createFFmpegConverter(): AudioConverter {
  const ffmpegPath = resolveFFmpegPath();
  
  return {
    convertToMp3: async (input, output, bitrate) => {
      assertFilesystemPath(output);
      const { spawn } = require('child_process');
      
      return new Promise((resolve) => {
        const args = [
          '-i', input,
          '-vn',         // skip video/cover-art streams
          '-ab', bitrate,
          '-ar', '44100',
          '-ac', '2',
          '-y',          // overwrite output
          output,
        ];
        
        const process = spawn(ffmpegPath, args, { stdio: 'ignore' });
        
        process.on('error', (err: Error) => {
          resolve({
            success: false,
            error: `FFmpeg error: ${err.message}`,
          });
        });
        
        process.on('close', (code: number) => {
          resolve({
            success: code === 0,
            error: code !== 0 ? `FFmpeg exited with code ${code}` : undefined,
          });
        });
      });
    },
    
    convertStreamToMp3: async (inputStream, output, bitrate) => {
      assertFilesystemPath(output);
      const { spawn } = require('child_process');

      return new Promise((resolve) => {
        const args = [
          '-i', 'pipe:0',  // read from stdin
          '-vn',
          '-ab', bitrate,
          '-ar', '44100',
          '-ac', '2',
          '-y',
          output,
        ];

        const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });

        let stderr = '';
        proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

        proc.on('error', (err: Error) => {
          resolve({ success: false, error: `FFmpeg error: ${err.message}` });
        });

        proc.on('close', (code: number) => {
          if (code !== 0) {
            console.error(`[sync-files] convertStreamToMp3 FFmpeg failed for ${output}: code=${code}`, `\nargs: ${args.join(' ')}`, `\nstderr: ${stderr}`);
          }
          resolve({
            success: code === 0,
            error: code !== 0 ? `FFmpeg exited with code ${code}` : undefined,
          });
        });

        // Suppress EPIPE — FFmpeg may close stdin early on format error
        proc.stdin.on('error', () => {});

        inputStream.on('error', (err: Error) => {
          try { proc.kill(); } catch { /* already dead */ }
          resolve({ success: false, error: `Stream error: ${err.message}` });
        });

        inputStream.pipe(proc.stdin);
      });
    },

    convertStreamToMp3WithMeta: async (inputStream, output, bitrate, metadata, embedCover) => {
      assertFilesystemPath(output);
      const { spawn } = require('child_process');
      const fs = require('fs');
      const os = require('os');

      return new Promise((resolve) => {
        // Build args: inputs first, then encoding params, then metadata, then output.
        // FFmpeg requires all -i / -map / -vn flags to appear after their input, not before.
        const args: string[] = [];
        let coverTempPath: string | undefined;

        // Input 0: audio from stdin (always present)
        args.push('-i', 'pipe:0');

        // Input 1: cover art image (only when embedding)
        if (embedCover) {
          coverTempPath = `${os.tmpdir()}/jt-cover-${Date.now()}.jpg`;
          fs.writeFileSync(coverTempPath, embedCover);
          args.push('-i', coverTempPath);
        }

        // Stream mapping and encoding — use -vn unless we have a video stream from cover art
        if (!embedCover) args.push('-vn');
        args.push('-ab', bitrate, '-ar', '44100', '-ac', '2');

        // Map streams: audio from stdin (input 0), video from cover (input 1)
        if (embedCover) {
          args.push('-map', '0:a', '-map', '1:v', '-disposition:v', 'attached_pic');
        }

        // Metadata flags — all fields sanitized before passing to FFmpeg
        if (metadata.title) args.push('-metadata', `title=${sanitizeMetadataField(metadata.title)}`);
        if (metadata.artist) args.push('-metadata', `artist=${sanitizeMetadataField(metadata.artist)}`);
        if (metadata.albumArtist) args.push('-metadata', `album_artist=${sanitizeMetadataField(metadata.albumArtist)}`);
        if (metadata.album) args.push('-metadata', `album=${sanitizeMetadataField(metadata.album)}`);
        const year = sanitizeNumericField(metadata.year ?? '');
        if (year) args.push('-metadata', `date=${year}`);
        const track = sanitizeNumericField(metadata.trackNumber ?? '');
        if (track) args.push('-metadata', `track=${track}`);
        const disc = sanitizeNumericField(metadata.discNumber ?? '');
        if (disc) args.push('-metadata', `disc=${disc}`);
        if (metadata.genres?.length) args.push('-metadata', `genre=${metadata.genres.map(g => sanitizeMetadataField(g)).join(';')}`);
        if (metadata.composer) args.push('-metadata', `composer=${sanitizeMetadataField(metadata.composer)}`);
        if (metadata.isrc) args.push('-metadata', `isrc=${sanitizeMetadataField(metadata.isrc)}`);
        if (metadata.copyright) args.push('-metadata', `copyright=${sanitizeMetadataField(metadata.copyright)}`);
        if (metadata.comment) args.push('-metadata', `comment=${sanitizeMetadataField(metadata.comment)}`);

        args.push('-y', output);

        const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

        let stderr = '';
        proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

        proc.on('error', (err: Error) => {
          if (coverTempPath) try { fs.unlinkSync(coverTempPath); } catch { /* ignore */ }
          resolve({ success: false, error: `FFmpeg error: ${err.message}` });
        });

        proc.on('close', (code: number) => {
          if (coverTempPath) try { fs.unlinkSync(coverTempPath); } catch { /* ignore */ }
          if (code !== 0) {
            console.error(`[sync-files] FFmpeg failed for ${output}: code=${code}`, `\nargs: ${args.join(' ')}`, `\nstderr: ${stderr}`);
          }
          resolve({
            success: code === 0,
            error: code !== 0 ? `FFmpeg exited with code ${code}` : undefined,
          });
        });

        // Suppress EPIPE
        proc.stdin.on('error', () => {});

        inputStream.on('error', (err: Error) => {
          try { proc.kill(); } catch { /* already dead */ }
          if (coverTempPath) try { fs.unlinkSync(coverTempPath); } catch { /* ignore */ }
          resolve({ success: false, error: `Stream error: ${err.message}` });
        });

        inputStream.pipe(proc.stdin);
      });
    },

    tagFile: async (inputPath, outputPath, metadata, embedCover) => {
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
        const tempOutputPath = useTempOutput ? `${os.tmpdir()}/jt-tag-${Date.now()}${ext}` : outputPath;

        // Build complete args array BEFORE spawning — all inputs and flags before output
        const args: string[] = ['-i', inputPath];

        // Handle cover art via temp file — insert immediately after first -i
        let coverTempPath: string | undefined;
        if (embedCover) {
          coverTempPath = `${os.tmpdir()}/jt-cover-${Date.now()}.jpg`;
          fs.writeFileSync(coverTempPath, embedCover);
          args.push('-i', coverTempPath, '-map', '0:a', '-map', '1:v', '-disposition:v', 'attached_pic');
        }

        args.push('-c', 'copy', '-y');

        // Metadata flags — must appear AFTER all inputs but before output path
        if (metadata.title) args.push('-metadata', `title=${sanitizeMetadataField(metadata.title)}`);
        if (metadata.artist) args.push('-metadata', `artist=${sanitizeMetadataField(metadata.artist)}`);
        if (metadata.albumArtist) args.push('-metadata', `album_artist=${sanitizeMetadataField(metadata.albumArtist)}`);
        if (metadata.album) args.push('-metadata', `album=${sanitizeMetadataField(metadata.album)}`);
        const year = sanitizeNumericField(metadata.year ?? '');
        if (year) args.push('-metadata', `date=${year}`);
        const track = sanitizeNumericField(metadata.trackNumber ?? '');
        if (track) args.push('-metadata', `track=${track}`);
        const disc = sanitizeNumericField(metadata.discNumber ?? '');
        if (disc) args.push('-metadata', `disc=${disc}`);
        if (metadata.genres?.length) args.push('-metadata', `genre=${metadata.genres.map(g => sanitizeMetadataField(g)).join(';')}`);
        if (metadata.composer) args.push('-metadata', `composer=${sanitizeMetadataField(metadata.composer)}`);
        if (metadata.isrc) args.push('-metadata', `isrc=${sanitizeMetadataField(metadata.isrc)}`);
        if (metadata.copyright) args.push('-metadata', `copyright=${sanitizeMetadataField(metadata.copyright)}`);
        if (metadata.comment) args.push('-metadata', `comment=${sanitizeMetadataField(metadata.comment)}`);

        args.push(tempOutputPath);

        const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });

        let stderr = '';
        proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

        proc.on('error', (err: Error) => {
          if (coverTempPath) try { fs.unlinkSync(coverTempPath); } catch { /* ignore */ }
          resolve({ success: false, error: `FFmpeg error: ${err.message}` });
        });

        proc.on('close', (code: number) => {
          if (coverTempPath) try { fs.unlinkSync(coverTempPath); } catch { /* ignore */ }
          if (code === 0 && useTempOutput) {
            // Move temp file to final destination
            try {
              fs.unlinkSync(finalOutputPath);
              fs.renameSync(tempOutputPath, finalOutputPath);
            } catch (renameErr) {
              console.error(`[sync-files] tagFile failed to replace ${finalOutputPath}:`, renameErr);
              try { fs.unlinkSync(tempOutputPath); } catch { /* ignore */ }
              resolve({ success: false, error: `Failed to replace file: ${renameErr}` });
              return;
            }
          }
          if (code !== 0) {
            if (useTempOutput) try { fs.unlinkSync(tempOutputPath); } catch { /* ignore */ }
            console.error(`[sync-files] tagFile FFmpeg failed for ${outputPath}: code=${code}`, `\nargs: ${args.join(' ')}`, `\nstderr: ${stderr}`);
          }
          resolve({
            success: code === 0,
            error: code !== 0 ? `FFmpeg exited with code ${code}` : undefined,
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
        const args = [
          '-v', 'quiet',
          '-print_format', 'json',
          '-show_format',
          filePath,
        ];

        const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });

        let stdout = '';
        proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

        proc.on('error', () => { resolve({}); });
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
  };
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
  };
}

/**
 * Validate destination path
 */
export async function validateDestination(
  path: string,
  fs: FileSystem
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
  return filename
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[^\x00-\x7F]/g, (c) => c) // Keep unicode characters
    .slice(0, 255); // Max filename length
}

/**
 * Create unique filename if file exists
 */
export async function getUniqueFilename(
  basePath: string,
  filename: string,
  fs: FileSystem
): Promise<string> {
  const ext = filename.match(/\.[^.]+$/)?.[0] || '';
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
  if (!await fs.exists(path)) {
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
  onProgress?: (bytesCopied: number, totalBytes: number) => void
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
  jellyfinMeta: TrackMetadata
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
    genres: jellyfinMeta.genres?.length ? jellyfinMeta.genres : fileMeta.genre ? [fileMeta.genre] : undefined,
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