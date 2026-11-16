import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, login } from '../support/app';
import { addDestination, dismissSyncSuccessModal, listTree, selectAlbum } from '../support/actions';

/**
 * E12 — legacy ID3 tags.
 *
 * The per-device "Use legacy ID3 tags" switch writes MP3 files with
 * ID3v2.3 (`-id3v2_version 3`) for older players that cannot read ID3v2.4
 * — e.g. the Sony NWZ-B183F, which ignores v2.4 entirely and falls back
 * to ID3v1 or the filename.
 *
 * Two paths are covered:
 *   E12a — FLAC sources converted to MP3 with legacy tags on.
 *   E12b — MP3 sources copied as-is (128k fixtures, so needsConversion()
 *          is false at 192k). These store no encoded_bitrate, and a second
 *          preview must still report them as already synced — the
 *          regression that made copied MP3s look permanently out of sync.
 */

interface Id3Info {
  major: number;
  frames: string[];
  hasId3v1: boolean;
}

function syncsafe(bytes: Buffer): number {
  return (
    ((bytes[0] & 0x7f) << 21) |
    ((bytes[1] & 0x7f) << 14) |
    ((bytes[2] & 0x7f) << 7) |
    (bytes[3] & 0x7f)
  );
}

/** Parse the ID3v2 header and frame IDs from the start of an MP3 file. */
function parseId3(path: string): Id3Info {
  const data = readFileSync(path);
  expect(data.subarray(0, 3).toString('latin1'), `${path} has no ID3v2 tag`).toBe('ID3');

  const major = data[3];
  const tagSize = syncsafe(data.subarray(6, 10));
  const frames: string[] = [];
  let offset = 10;

  while (offset + 10 <= 10 + tagSize) {
    const id = data.subarray(offset, offset + 4).toString('latin1');
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size =
      major === 4 ? syncsafe(data.subarray(offset + 4, offset + 8)) : data.readUInt32BE(offset + 4);
    frames.push(id);
    offset += 10 + size;
  }

  return { major, frames, hasId3v1: data.subarray(-128, -125).toString('latin1') === 'TAG' };
}

async function enableLegacyTags(page: Page): Promise<void> {
  await page.getByTestId('mp3-toggle').click();
  const legacy = page.getByTestId('id3-legacy-toggle');
  await legacy.click();
  await expect(legacy).toHaveAttribute('aria-checked', 'true');
}

function mp3Files(destDir: string): string[] {
  return listTree(destDir).filter((file) => file.endsWith('.mp3'));
}

test('E12a: legacy mode converts FLAC sources to ID3v2.3 MP3s', async ({
  page,
  app,
  destDir,
  serverConfig,
}) => {
  await login(page, serverConfig);
  await addDestination(page, app, destDir);
  await selectAlbum(page, 'Album Alpha');

  await page.locator(`[data-testid="device-item"][data-device-path="${destDir}"]`).click();
  await page.getByTestId('sync-panel').waitFor({ state: 'visible', timeout: 15_000 });

  await enableLegacyTags(page);

  await page.getByTestId('sync-button').click();
  await page.getByTestId('sync-preview-modal').waitFor({ state: 'visible', timeout: 20_000 });
  await expect(page.getByTestId('preview-new-tracks-section')).toContainText('3 tracks');
  await page.getByTestId('confirm-sync-button').click();
  await expect(page.getByTestId('sync-preview-modal')).toBeHidden();

  await expect.poll(() => mp3Files(destDir).length, { timeout: 180_000 }).toBe(3);

  for (const relative of mp3Files(destDir)) {
    const info = parseId3(join(destDir, relative));
    expect(info.major, `${relative} is not ID3v2.3`).toBe(3);
    expect(info.frames, `${relative} is missing TYER`).toContain('TYER');
    expect(info.frames, `${relative} must not contain the v2.4 TDRC frame`).not.toContain('TDRC');
    expect(info.hasId3v1, `${relative} unexpectedly has an ID3v1 tag`).toBe(false);
  }
});

test('E12b: legacy mode on copied MP3s stays in sync on a second preview', async ({
  page,
  app,
  destDir,
  serverConfig,
}) => {
  await login(page, serverConfig);
  await addDestination(page, app, destDir);
  await selectAlbum(page, 'Album Beta');

  await page.locator(`[data-testid="device-item"][data-device-path="${destDir}"]`).click();
  await page.getByTestId('sync-panel').waitFor({ state: 'visible', timeout: 15_000 });

  await enableLegacyTags(page);

  await page.getByTestId('sync-button').click();
  await page.getByTestId('sync-preview-modal').waitFor({ state: 'visible', timeout: 20_000 });
  await expect(page.getByTestId('preview-new-tracks-section')).toContainText('2 tracks');
  await page.getByTestId('confirm-sync-button').click();
  await expect(page.getByTestId('sync-preview-modal')).toBeHidden();

  await expect.poll(() => mp3Files(destDir).length, { timeout: 120_000 }).toBe(2);

  for (const relative of mp3Files(destDir)) {
    const info = parseId3(join(destDir, relative));
    expect(info.major, `${relative} is not ID3v2.3`).toBe(3);
    expect(info.frames).toContain('TYER');
    expect(info.hasId3v1).toBe(false);
  }

  await dismissSyncSuccessModal(page);
  await page.getByTestId('sync-panel').waitFor({ state: 'visible', timeout: 15_000 });

  // Second preview: nothing new, nothing updated. Copied MP3s store no
  // encoded_bitrate, so this is also the regression guard for the diff rule.
  await page.getByTestId('sync-button').click();
  await page.getByTestId('sync-preview-modal').waitFor({ state: 'visible', timeout: 20_000 });
  await expect(page.getByTestId('preview-already-synced-section')).toContainText('2 tracks');
  await expect(page.getByTestId('preview-new-tracks-section')).toBeHidden();
});
