import { readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, login } from '../support/app';
import { addDestination, listTree, selectAlbum } from '../support/actions';

const TEMP_PREFIXES = ['jellytunes_', 'jt-'];

function strayTempFiles(): string[] {
  return readdirSync(tmpdir()).filter((name) => TEMP_PREFIXES.some((p) => name.startsWith(p)));
}

// FIXED (ORAIN-0674): cancellation checkpoints added in copyTrackFile and
// convertAndCopy so that tracks in-flight when cancel is called are aborted
// before any file is written. Unit test verifies the behaviour.
// STABILISED (ORAIN-0697): the old test waited on `cancel-sync-button` to
// hide. That is racy on fast hardware — FFmpeg encodes 120 s noise → MP3 in
// under a second on Apple Silicon, so by the time the click reached the IPC
// handler the sync had already ended, the button hid, and the only remaining
// assertion (`finalTree.length < 3`) silently passed even though we never
// cancelled anything. We now synchronise on observable DOM state instead of
// the clock:
//
//   1. Wait for `cancel-sync-button` to appear — proves we entered sync.
//   2. Wait for the SyncProgressBar phase label to read `Copying...` or
//      `Converting...` — proves we are inside the cancellable window (past
//      `fetching`, where the IPC call had not yet returned any progress).
//      SyncProgressBar renders the label in `span.text-label-md.uppercase`.
//   3. Click cancel.
//   4. Assert the label transitions to `CANCELLING…` — the only branch where
//      this label is set is `handleCancelSync` writing
//      `setSyncProgress({ ...prev, isCancelling: true })` synchronously
//      (useSync.ts:535). If the sync had already completed the progress bar
//      unmounts entirely (syncProgress = null), so seeing `CANCELLING…`
//      proves the click landed in time. If we never see it, the race was
//      lost and the test fails loudly instead of silently passing.
test('E5: cancelling a sync leaves no partial files and no temp orphans', async ({
  page,
  app,
  destDir,
  serverConfig,
}) => {
  const strayBefore = new Set(strayTempFiles());

  await login(page, serverConfig);
  await addDestination(page, app, destDir);

  // Select Album Gamma (3×120s noise for a reliable cancel window)
  await selectAlbum(page, 'Album Gamma');

  // Return to device sync panel with selections
  await page.locator(`[data-testid="device-item"][data-device-path="${destDir}"]`).click();
  await page.getByTestId('sync-panel').waitFor({ state: 'visible', timeout: 15_000 });

  // MP3 conversion enables cancellation during conversion
  await page.getByTestId('mp3-toggle').click();

  await page.getByTestId('sync-button').click();
  await page.getByTestId('sync-preview-modal').waitFor({ state: 'visible' });
  await expect(page.getByTestId('preview-new-tracks-section')).toContainText('3 tracks');
  await page.getByTestId('confirm-sync-button').click();

  // 1. Sync has started — cancel button is rendered.
  const cancelButton = page.getByTestId('cancel-sync-button');
  await cancelButton.waitFor({ state: 'visible', timeout: 45_000 });

  // 2. Sync is inside the cancellable window — Copying or Converting.
  // The phase label sits in SyncProgressBar (data-testid="sync-phase-label"
  // added in ORAIN-0697 to disambiguate from DeviceSyncPanel's "Storage"
  // section header, which uses identical Tailwind classes). Source text is
  // mixed case; CSS uppercases it visually only.
  const phaseLabel = page.getByTestId('sync-phase-label');
  await expect(phaseLabel).toHaveText(/^(Copying|Converting)\.\.\.$/, { timeout: 60_000 });

  // 3. Now in the cancellable window — click cancel.
  await cancelButton.click();

  // 4. The cancellation was processed: isCancelling flipped synchronously
  //    in handleCancelSync (useSync.ts:535), so SyncProgressBar shows
  //    "CANCELLING…" until phaseManager.cancelled() emits phase='cancelled'.
  //    If we never see this label, the sync already completed and the
  //    progress bar unmounted (syncProgress = null) before our click landed.
  await expect(
    phaseLabel,
    'cancel arrived after sync completed — phase went straight from ' +
      'Copying/Converting to unmount without isCancelling, race was lost. ' +
      'Either fixtures finished too fast (lengthen Album Gamma) or the ' +
      'cancellation checkpoint (ORAIN-0674) is missing.',
  ).toHaveText(/^CANCELLING…$/, { timeout: 30_000 });

  await expect(
    page.getByTestId('cancel-sync-button'),
    'cancel button should hide once sync transitions out of isSyncing',
  ).toBeHidden({ timeout: 120_000 });

  const finalTree = listTree(destDir);
  expect(
    finalTree.length,
    `cancelled sync still wrote every track: ${finalTree.join(', ')}`,
  ).toBeLessThan(3);

  for (const rel of finalTree) {
    const size = statSync(join(destDir, rel)).size;
    expect(size, `${rel} is a zero-byte partial`).toBeGreaterThan(0);
  }

  await expect
    .poll(() => strayTempFiles().filter((f) => !strayBefore.has(f)), { timeout: 30_000 })
    .toEqual([]);
});
