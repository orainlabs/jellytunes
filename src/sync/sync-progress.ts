/**
 * Sync Progress Module
 *
 * Manages progress events, phase tracking, and cancellation.
 * Designed for real-time UI updates during sync operations.
 */

import type { SyncProgress, SyncPhase, ProgressCallback } from './types';

/**
 * Progress emitter interface
 */
export interface ProgressEmitter {
  /** Subscribe to progress events */
  subscribe(callback: ProgressCallback): () => void;

  /** Emit progress update */
  emit(progress: SyncProgress): void;

  /** Get current progress */
  getCurrent(): SyncProgress | null;
}

/**
 * Create a progress emitter
 */
export function createProgressEmitter(): ProgressEmitter {
  const subscribers: Set<ProgressCallback> = new Set();
  let currentProgress: SyncProgress | null = null;

  return {
    subscribe: (callback: ProgressCallback) => {
      subscribers.add(callback);

      // Immediately notify of current state if available
      if (currentProgress) {
        callback(currentProgress);
      }

      // Return unsubscribe function
      return () => {
        subscribers.delete(callback);
      };
    },

    emit: (progress: SyncProgress) => {
      currentProgress = progress;

      for (const callback of subscribers) {
        try {
          callback(progress);
        } catch (_error) {
          // Swallow callback errors silently — log is not available in this module
        }
      }
    },

    getCurrent: () => currentProgress,
  };
}

/**
 * Cancellation controller interface
 */
export interface CancellationController {
  /** Request cancellation */
  cancel(): void;

  /** Check if cancellation was requested */
  isCancelled(): boolean;

  /** Throw if cancelled */
  throwIfCancelled(): void;

  /** Reset cancellation state */
  reset(): void;
}

/**
 * Create a cancellation controller
 */
export function createCancellationController(): CancellationController {
  let cancelled = false;

  return {
    cancel: () => {
      cancelled = true;
    },

    isCancelled: () => cancelled,

    throwIfCancelled: () => {
      if (cancelled) {
        throw new SyncCancelledError();
      }
    },

    reset: () => {
      cancelled = false;
    },
  };
}

/**
 * Error thrown when sync is cancelled
 */
export class SyncCancelledError extends Error {
  constructor() {
    super('Sync operation was cancelled');
    this.name = 'SyncCancelledError';
  }
}

/**
 * Progress builder for fluent progress updates
 */
export class ProgressBuilder {
  private progress: SyncProgress;

  constructor(total: number) {
    this.progress = {
      phase: 'fetching',
      current: 0,
      total,
    };
  }

  /** Set phase */
  phase(phase: SyncPhase): this {
    this.progress.phase = phase;
    return this;
  }

  /** Set current item */
  current(current: number): this {
    this.progress.current = current;
    return this;
  }

  /** Set current track name */
  track(name: string): this {
    this.progress.currentTrack = name;
    return this;
  }

  /** Set bytes processed */
  bytes(processed: number, total?: number): this {
    this.progress.bytesProcessed = processed;
    if (total !== undefined) {
      this.progress.totalBytes = total;
    }
    return this;
  }

  /** Set error */
  error(message: string): this {
    this.progress.phase = 'error';
    this.progress.errorMessage = message;
    return this;
  }

  /** Build the progress object */
  build(): SyncProgress {
    return { ...this.progress };
  }
}

/**
 * Create progress builder
 */
export function progress(total: number): ProgressBuilder {
  return new ProgressBuilder(total);
}

/**
 * Progress statistics tracker
 */
export interface ProgressStats {
  /** Time when sync started */
  startTime: number;
  /** Number of items processed (copied/converted) */
  itemsProcessed: number;
  /** Number of items skipped (already up-to-date) */
  itemsSkipped: number;
  /** Number of items failed */
  itemsFailed: number;
  /** Total bytes transferred */
  bytesTransferred: number;
  /** Number of items converted */
  itemsConverted: number;
}

/**
 * Create progress stats tracker
 */
export function createProgressStats(): ProgressStats {
  return {
    startTime: 0,
    itemsProcessed: 0,
    itemsSkipped: 0,
    itemsFailed: 0,
    bytesTransferred: 0,
    itemsConverted: 0,
  };
}

/**
 * Calculate estimated time remaining
 */
export function estimateTimeRemaining(stats: ProgressStats, itemsRemaining: number): number | null {
  if (stats.itemsProcessed === 0 || stats.startTime === 0) {
    return null;
  }

  const elapsed = Date.now() - stats.startTime;
  const avgTimePerItem = elapsed / stats.itemsProcessed;

  return Math.round(avgTimePerItem * itemsRemaining);
}

/**
 * Format time remaining for display
 */
export function formatTimeRemaining(ms: number | null): string {
  if (ms === null) return '';

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m remaining`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s remaining`;
  }

  return `${seconds}s remaining`;
}

/**
 * Phase transition helper
 */
export class PhaseManager {
  private currentPhase: SyncPhase = 'fetching';
  private emitter: ProgressEmitter;

  constructor(emitter: ProgressEmitter) {
    this.emitter = emitter;
  }

  /** Start fetching phase */
  startFetching(total: number): void {
    this.currentPhase = 'fetching';
    this.emitter.emit({
      phase: 'fetching',
      current: 0,
      total,
    });
  }

  /** Update fetching progress */
  updateFetching(current: number, total: number): void {
    this.emitter.emit({
      phase: 'fetching',
      current,
      total,
    });
  }

  /** Start copying phase */
  startCopying(total: number): void {
    this.currentPhase = 'copying';
    this.emitter.emit({
      phase: 'copying',
      current: 0,
      total,
    });
  }

  /** Update copying progress with optional bytes tracking */
  updateCopying(
    current: number,
    total: number,
    track?: string,
    totalBytes?: number,
    bytesProcessed?: number,
  ): void {
    this.emitter.emit({
      phase: 'copying',
      current,
      total,
      currentTrack: track,
      totalBytes,
      bytesProcessed,
    });
  }

  /** Start converting phase */
  startConverting(total: number): void {
    this.currentPhase = 'converting';
    this.emitter.emit({
      phase: 'converting',
      current: 0,
      total,
    });
  }

  /** Update converting progress */
  updateConverting(current: number, total: number, track?: string): void {
    this.emitter.emit({
      phase: 'converting',
      current,
      total,
      currentTrack: track,
    });
  }

  /** Mark as complete */
  complete(stats: ProgressStats): void {
    this.currentPhase = 'complete';
    this.emitter.emit({
      phase: 'complete',
      current: stats.itemsProcessed,
      total: stats.itemsProcessed,
      bytesProcessed: stats.bytesTransferred,
    });
  }

  /** Mark as cancelled */
  cancelled(current: number, total: number): void {
    this.currentPhase = 'cancelled';
    this.emitter.emit({
      phase: 'cancelled',
      current,
      total,
    });
  }

  /** Mark as error */
  error(message: string): void {
    this.currentPhase = 'error';
    this.emitter.emit({
      phase: 'error',
      current: 0,
      total: 0,
      errorMessage: message,
    });
  }

  /** Get current phase */
  getPhase(): SyncPhase {
    return this.currentPhase;
  }
}
