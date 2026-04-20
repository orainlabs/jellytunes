/**
 * Sync Configuration Module
 *
 * Handles configuration validation, defaults, and normalization.
 * Pure functions with no external dependencies.
 */

import path from 'path';
import type { SyncConfig, SyncOptions, ConfigValidationResult, FilesystemType } from './types';

export type { FilesystemType };

/**
 * Default sync options
 */
export const DEFAULT_SYNC_OPTIONS: Required<SyncOptions> = {
  convertToMp3: false,
  bitrate: '192k',
  skipExisting: true,
  preserveStructure: true,
  filesystemType: 'unknown',
  embedMetadata: true,
  coverArtMode: 'embed',
};

/** Windows/FAT32 reserved filenames that cannot exist on those filesystems */
const FAT32_RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)/i;

/**
 * Sanitize a single path component (directory name or filename) for FAT32/exFAT/NTFS.
 * - Replaces forbidden characters with `_`
 * - Strips trailing dots and spaces (FAT32 silently removes them, causing path mismatches)
 * - Prefixes Windows-reserved names
 * - Truncates to 255 chars while preserving extension
 * - Never returns an empty string (falls back to `_`)
 *
 * For non-Windows-family filesystems the segment is returned unchanged.
 */
export function sanitizePathComponent(segment: string, filesystem: FilesystemType): string {
  if (filesystem !== 'fat32' && filesystem !== 'exfat' && filesystem !== 'ntfs') return segment;

  let s = segment;
  // Characters forbidden on FAT32/NTFS (forward slash is already a path separator, not in components)
  s = s.replace(/[<>:"|?*\\]/g, '_');
  // FAT32 silently strips trailing dots and spaces — make the stripping explicit so paths match
  s = s.replace(/[. ]+$/, '');
  // Strip leading spaces
  s = s.replace(/^ +/, '');
  // Truncate to 255 chars, keeping the file extension intact
  if (s.length > 255) {
    const extMatch = s.match(/(\.[^.]+)$/);
    if (extMatch) {
      s = s.slice(0, 255 - extMatch[1].length) + extMatch[1];
    } else {
      s = s.slice(0, 255);
    }
  }
  // Prefix Windows-reserved names (e.g. CON → _CON)
  if (FAT32_RESERVED_RE.test(s)) {
    s = '_' + s;
  }
  return s || '_';
}

/**
 * Valid bitrates for MP3 conversion
 */
export const VALID_BITRATES = ['128k', '192k', '320k'] as const;
export type ValidBitrate = typeof VALID_BITRATES[number];

/**
 * Valid audio formats
 */
export const AUDIO_FORMATS = ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'wav'] as const;
export type AudioFormat = typeof AUDIO_FORMATS[number];

/**
 * Formats that support conversion to MP3
 */
export const CONVERTIBLE_FORMATS = ['flac', 'wav', 'm4a', 'aac', 'ogg'] as const;

/**
 * Normalize server URL (remove trailing slash, ensure protocol)
 */
export function normalizeServerUrl(url: string): string {
  let normalized = url.trim();
  
  // Remove trailing slashes
  normalized = normalized.replace(/\/+$/, '');
  
  // Ensure protocol
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = `https://${normalized}`;
  }
  
  // Remove /web, /web/index.html, etc.
  normalized = normalized.replace(/\/web.*$/, '');
  
  return normalized;
}

/**
 * Validate API key format (basic checks)
 */
export function validateApiKey(apiKey: string): { valid: boolean; error?: string } {
  if (!apiKey || typeof apiKey !== 'string') {
    return { valid: false, error: 'API key is required' };
  }
  
  const trimmed = apiKey.trim();
  
  if (trimmed.length === 0) {
    return { valid: false, error: 'API key cannot be empty' };
  }
  
  // Jellyfin API keys are typically 32 character hex strings
  if (!/^[a-f0-9]{32}$/i.test(trimmed)) {
    // Accept but warn if format doesn't match expected
    return { valid: true };
  }
  
  return { valid: true };
}

/**
 * Validate user ID format
 */
export function validateUserId(userId: string): { valid: boolean; error?: string } {
  if (!userId || typeof userId !== 'string') {
    return { valid: false, error: 'User ID is required' };
  }
  
  const trimmed = userId.trim();
  
  if (trimmed.length === 0) {
    return { valid: false, error: 'User ID cannot be empty' };
  }
  
  // Jellyfin IDs are 32 character hex strings
  if (!/^[a-f0-9]{32}$/i.test(trimmed)) {
    return { valid: false, error: 'User ID must be a 32-character hex string' };
  }
  
  return { valid: true };
}

/**
 * Validate server root path format
 */
export function validateServerRootPath(path: string): { valid: boolean; error?: string } {
  if (!path) {
    // Optional field, empty is valid
    return { valid: true };
  }
  
  const trimmed = path.trim();
  
  if (trimmed.length === 0) {
    return { valid: true };
  }
  
  // Must start with /
  if (!trimmed.startsWith('/')) {
    return { valid: false, error: 'Server root path must start with /' };
  }
  
  // Must end with /
  if (!trimmed.endsWith('/')) {
    return { valid: false, error: 'Server root path must end with /' };
  }
  
  return { valid: true };
}

/**
 * Validate complete SyncConfig
 */
export function validateSyncConfig(config: unknown): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Configuration is required'] };
  }
  
  const cfg = config as Partial<SyncConfig>;
  
  // Server URL validation
  if (!cfg.serverUrl) {
    errors.push('Server URL is required');
  } else {
    try {
      const normalized = normalizeServerUrl(cfg.serverUrl);
      new URL(normalized);
    } catch {
      errors.push('Server URL is not a valid URL');
    }
  }
  
  // API key validation
  if (!cfg.apiKey) {
    errors.push('API key is required');
  } else {
    const { valid, error } = validateApiKey(cfg.apiKey);
    if (!valid && error) {
      errors.push(error);
    }
  }
  
  // User ID validation
  if (!cfg.userId) {
    errors.push('User ID is required');
  } else {
    const { valid, error } = validateUserId(cfg.userId);
    if (!valid && error) {
      errors.push(error);
    }
  }
  
  // Server root path validation (optional)
  if (cfg.serverRootPath) {
    const { valid, error } = validateServerRootPath(cfg.serverRootPath);
    if (!valid && error) {
      errors.push(error);
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Merge user options with defaults
 */
export function resolveSyncOptions(options?: SyncOptions): Required<SyncOptions> {
  return {
    ...DEFAULT_SYNC_OPTIONS,
    ...options,
  };
}

/**
 * Check if format requires conversion to MP3
 */
export function needsConversion(format: string, options: Required<SyncOptions>): boolean {
  if (!options.convertToMp3) return false;
  
  const normalizedFormat = format.toLowerCase();
  return CONVERTIBLE_FORMATS.includes(normalizedFormat as any);
}

/**
 * Get output file extension based on options
 */
export function getOutputExtension(originalFormat: string, options: Required<SyncOptions>): string {
  if (needsConversion(originalFormat, options)) {
    return 'mp3';
  }
  return originalFormat.toLowerCase();
}

/**
 * Build filename for sync output
 */
export function buildSyncFilename(
  track: { name: string; path: string; format: string; trackNumber?: number },
  options: Required<SyncOptions>
): string {
  const baseName = track.path.split('/').pop() || track.name;
  const extension = getOutputExtension(track.format, options);
  
  // If track has number and preserve structure, format accordingly
  if (track.trackNumber && options.preserveStructure) {
    const paddedNumber = String(track.trackNumber).padStart(2, '0');
    const nameWithoutExt = baseName.replace(/\.[^.]+$/, '');
    return `${paddedNumber} - ${nameWithoutExt}.${extension}`;
  }
  
  // Replace extension if converted
  return baseName.replace(/\.[^.]+$/, `.${extension}`);
}

/**
 * Check whether a path (or single segment) contains a literal ".." traversal segment.
 * Normalizes consecutive slashes before splitting.
 */
export function hasTraversalSegment(pathOrSegment: string): boolean {
  return pathOrSegment.replace(/\/+/g, '/').split('/').some(s => s === '..');
}

/**
 * Build full output path with optional folder structure
 */
export function buildOutputPath(
  track: { name: string; artists?: string[]; album?: string; trackNumber?: number },
  destinationPath: string,
  options: Required<SyncOptions>
): string {
  if (!options.preserveStructure) {
    return destinationPath;
  }
  
  const parts = [destinationPath];
  
  // Artist folder
  if (track.artists && track.artists.length > 0) {
    // Sanitize artist name for filesystem
    const artistName = track.artists[0].replace(/[<>:"/\\|?*]/g, '_');
    parts.push(artistName);
  }
  
  // Album folder
  if (track.album) {
    const albumName = track.album.replace(/[<>:"/\\|?*]/g, '_');
    parts.push(albumName);
  }
  
  return parts.join('/');
}

/**
 * Configuration creation result
 */
export interface CreateConfigResult {
  success: boolean;
  config?: SyncConfig;
  errors: string[];
}

/**
 * Create validated configuration
 */
export function createSyncConfig(input: {
  serverUrl: string;
  apiKey: string;
  userId: string;
  serverRootPath?: string;
}): CreateConfigResult {
  const config: SyncConfig = {
    serverUrl: normalizeServerUrl(input.serverUrl),
    apiKey: input.apiKey.trim(),
    userId: input.userId.trim(),
    serverRootPath: input.serverRootPath?.trim() || undefined,
  };
  
  const validation = validateSyncConfig(config);
  
  return {
    success: validation.valid,
    config: validation.valid ? config : undefined,
    errors: validation.errors,
  };
}

/**
 * Build destination path from server path using server root mapping
 * 
 * @param serverPath - Full path from Jellyfin API (e.g., "/mediamusic/lib/lib/Ace/Five-A-Side/Ace - Five-A-Side - How Long.mp3")
 * @param serverRootPath - Server root to strip (e.g., "/mediamusic/lib/lib/")
 * @param destinationRoot - Local destination root (e.g., "/Volumes/MEDIA/lib")
 * @returns Full destination path (e.g., "/Volumes/MEDIA/lib/Ace/Five-A-Side/Ace - Five-A-Side - How Long.mp3")
 * @throws Error if the resulting path would escape the destination root (path traversal attempt)
 */
export function buildDestinationPath(
  serverPath: string,
  serverRootPath: string,
  destinationRoot: string
): string {
  const normalizedServer = path.normalize(serverPath);
  // Strip trailing separators so we can safely append path.sep for prefix checking
  const normalizedRoot = path.normalize(serverRootPath).replace(/[\/\\]$/, '');

  // Verify serverPath is actually under serverRootPath (not just a substring match)
  const rootWithSep = normalizedRoot + path.sep;
  if (!normalizedServer.startsWith(rootWithSep) && normalizedServer !== normalizedRoot) {
    throw new Error(`Path traversal detected: ${serverPath} is not under ${serverRootPath}`);
  }

  const relativePath = path.relative(normalizedRoot, normalizedServer);

  if (hasTraversalSegment(relativePath)) {
    throw new Error(`Invalid path: path traversal attempt detected in "${relativePath}"`);
  }

  // Join with destination root (normalize to remove duplicate slashes)
  return `${destinationRoot}/${relativePath}`.replace(/\/+/g, '/');
}

/**
 * Extract relative path from server path
 * 
 * @param serverPath - Full path from Jellyfin API
 * @param serverRootPath - Server root to strip
 * @returns Relative path (e.g., "Ace/Five-A-Side/Ace - Five-A-Side - How Long.mp3")
 */
export function getRelativePath(serverPath: string, serverRootPath: string): string {
  return serverPath.replace(serverRootPath, '');
}

/**
 * Extract filename from server path
 * 
 * @param serverPath - Full path from Jellyfin API
 * @returns Filename with extension
 */
export function getFilenameFromPath(serverPath: string): string {
  const parts = serverPath.split(/[/\\]/);
  return parts[parts.length - 1] || '';
}