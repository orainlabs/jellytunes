/**
 * Filesystem Operations Module
 * 
 * Handles file copying, conversion, and filesystem operations.
 * Pure functions with dependency injection for testing.
 */

import type { TrackInfo, DestinationValidation } from './types';
import { resolveFFmpegPath } from './ffmpeg-path';

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
  
  /** Check if FFmpeg is available */
  isAvailable(): Promise<boolean>;
}

export function createFFmpegConverter(): AudioConverter {
  const ffmpegPath = resolveFFmpegPath();
  
  return {
    convertToMp3: async (input, output, bitrate) => {
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
    
    isAvailable: async () => {
      const { execSync } = require('child_process');
      try {
        execSync(`${ffmpegPath} -version`, { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Create mock converter for testing
 */
export function createMockConverter(): AudioConverter {
  return {
    convertToMp3: async () => ({ success: true }),
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