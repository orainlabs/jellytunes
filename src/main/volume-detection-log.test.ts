/**
 * ORAIN-0740 AC4 — Volume detection logs only when the device set changes.
 *
 * The device-watcher polls `listUsbDevices()` every 15 s. The previous
 * implementation logged `Found N volumes` on every poll, which produced
 * ~240 lines per hour in main.log for a steady state. This helper
 * captures the diff against the previous poll and only emits when the
 * set actually changed — matching the `device-watcher.ts:237-245` pattern.
 *
 * Pure function — no fs, no electron, no process.platform branching.
 * Cross-platform by construction: takes the current device list and the
 * shared state as inputs.
 */
import { describe, it, expect, vi } from 'vitest';
import { diffAndLogVolumes, type VolumeLogState } from './log-scrub';

function makeState(): VolumeLogState {
  return { lastDeviceKeys: null, errorLogged: { logged: false } };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const dev = (path: string) => ({
  device: path,
  displayName: path,
  size: 0,
  mountpoints: [{ path }],
  isRemovable: true,
  vendorName: 'External',
});

describe('ORAIN-0740 AC4 — diffAndLogVolumes', () => {
  it('seeds the state on the first call (one log line, no diff)', () => {
    const state = makeState();
    const log = makeLogger();
    diffAndLogVolumes(state, [dev('/Volumes/USB1'), dev('/Volumes/USB2')], log);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('initial'));
    expect(state.lastDeviceKeys).toEqual(new Set(['/Volumes/USB1', '/Volumes/USB2']));
  });

  it('emits NOTHING on a second call with the same set (the AC4 ask)', () => {
    const state = makeState();
    const log = makeLogger();
    const devices = [dev('/Volumes/USB1'), dev('/Volumes/USB2')];
    diffAndLogVolumes(state, devices, log); // seed
    diffAndLogVolumes(state, devices, log); // steady state
    diffAndLogVolumes(state, devices, log); // steady state
    expect(log.info).toHaveBeenCalledTimes(1); // only the seed
  });

  it('emits attach + detach lines when a device is added and one removed', () => {
    const state = makeState();
    const log = makeLogger();
    diffAndLogVolumes(state, [dev('/Volumes/USB1'), dev('/Volumes/USB2')], log);
    diffAndLogVolumes(state, [dev('/Volumes/USB2'), dev('/Volumes/USB3')], log);
    expect(log.info).toHaveBeenCalledTimes(3); // seed + attach + detach
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('attached'));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('/Volumes/USB1'));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('detached'));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('/Volumes/USB3'));
  });

  it('does not emit when only the order changes (set semantics)', () => {
    const state = makeState();
    const log = makeLogger();
    diffAndLogVolumes(state, [dev('/Volumes/A'), dev('/Volumes/B')], log);
    diffAndLogVolumes(state, [dev('/Volumes/B'), dev('/Volumes/A')], log);
    expect(log.info).toHaveBeenCalledTimes(1); // seed only
  });
});
