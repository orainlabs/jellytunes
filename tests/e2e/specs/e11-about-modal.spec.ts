import { test, expect, login } from '../support/app';
import type { ElectronApplication } from '@playwright/test';

// ORAIN-0750 AC5: the About modal must not break its layout when rendered at
// the modal's natural width (448px = Tailwind max-w-md). At that width the
// previous two-row layout truncated or split the action labels.
//
// We verify three invariants per update-slot variant:
//   1. The modal does not horizontally overflow its own box (scrollWidth <= clientWidth).
//   2. The update slot fits on one line (offsetHeight matches h-12 = 48px).
//   3. The contact / external link group fits on one line (offsetHeight <= 24px
//      for text-body-sm + leading).
//
// Variants "Check Updates" and "Up to date" / "v{version}" are reachable by
// clicking "Check Updates" and patching the IPC reply. The Snap-managed variant
// requires the renderer to think it is running under snap, so we patch
// `app:isSnap` before the modal opens.

const MODAL_HTML = { w: 512, h: 800 } as const;

/** Patch the main-process IPC handler that the renderer's `checkForUpdates` resolves to. */
async function stubCheckForUpdates(
  app: ElectronApplication,
  payload: {
    updateAvailable: boolean;
    latestVersion: string;
    releaseUrl: string;
    managedBySnap: boolean;
  },
): Promise<void> {
  await app.evaluate(async ({ ipcMain }, reply) => {
    ipcMain.removeHandler('app:checkForUpdates');
    ipcMain.handle('app:checkForUpdates', () => reply);
  }, payload);
}

/** Patch the main-process IPC handler that the renderer's `isSnap` resolves to. */
async function stubIsSnap(app: ElectronApplication, isSnap: boolean): Promise<void> {
  await app.evaluate(async ({ ipcMain }, snap) => {
    ipcMain.removeHandler('app:isSnap');
    ipcMain.handle('app:isSnap', () => snap);
  }, isSnap);
}

async function openAboutModal(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('about-button').click();
  await page.getByTestId('about-modal').waitFor({ state: 'visible', timeout: 10_000 });
}

test.describe('E11: About modal layout at 448px modal width', () => {
  test.use({ viewport: MODAL_HTML });

  test('Check Updates variant fits in one line and does not overflow', async ({
    page,
    serverConfig,
  }) => {
    // Default IPC replies already yield "Check Updates" (not snap, no update
    // info yet). No patching needed for this variant.
    await login(page, serverConfig);
    await openAboutModal(page);

    const modal = page.getByTestId('about-modal');
    await expect(modal).toBeVisible();

    // Layout invariant 1: the modal box does not overflow horizontally.
    const overflow = await modal.evaluate(
      (el) => (el as HTMLElement).scrollWidth - (el as HTMLElement).clientWidth,
    );
    expect(overflow, 'modal scrollWidth must equal clientWidth').toBeLessThanOrEqual(1);

    // Layout invariant 2: the primary group renders in a single row (h-12 = 48px
    // per child, gap-4 spacing).
    const primaryGroup = page.getByTestId('about-group-primary');
    await expect(primaryGroup).toBeVisible();
    const primaryHeight = await primaryGroup.evaluate(
      (el) => (el as HTMLElement).getBoundingClientRect().height,
    );
    expect(primaryHeight, 'primary group fits on one row').toBeLessThanOrEqual(60);

    // "Check Updates" button is the visible variant.
    await expect(page.getByRole('button', { name: 'Check Updates' })).toBeVisible();
  });

  test('✓ Up to date variant fits in one line and does not overflow', async ({
    page,
    serverConfig,
    app,
  }) => {
    // The default `checkForUpdates()` reply on app start returns
    // updateAvailable=false, latestVersion=''. Clicking "Check Updates"
    // transitions the slot to "✓ Up to date".
    await stubCheckForUpdates(app, {
      updateAvailable: false,
      latestVersion: '',
      releaseUrl: '',
      managedBySnap: false,
    });
    await login(page, serverConfig);
    await openAboutModal(page);

    await page.getByRole('button', { name: 'Check Updates' }).click();
    await expect(page.getByText('✓ Up to date')).toBeVisible();

    const modal = page.getByTestId('about-modal');
    const overflow = await modal.evaluate(
      (el) => (el as HTMLElement).scrollWidth - (el as HTMLElement).clientWidth,
    );
    expect(overflow, 'modal scrollWidth must equal clientWidth').toBeLessThanOrEqual(1);

    const primaryHeight = await page
      .getByTestId('about-group-primary')
      .evaluate((el) => (el as HTMLElement).getBoundingClientRect().height);
    expect(primaryHeight, 'primary group still one row after click').toBeLessThanOrEqual(60);
  });

  test('v{latestVersion} variant fits in one line and does not overflow', async ({
    page,
    serverConfig,
    app,
  }) => {
    await stubCheckForUpdates(app, {
      updateAvailable: true,
      latestVersion: '9.9.9',
      releaseUrl: 'https://example.invalid/release',
      managedBySnap: false,
    });
    await login(page, serverConfig);
    await openAboutModal(page);

    // The modal checks for updates on mount, so the "Check Updates" button is already
    // replaced by the version link when an update is available.
    await expect(page.getByTestId('about-group-primary').getByText('v9.9.9')).toBeVisible();

    const modal = page.getByTestId('about-modal');
    const overflow = await modal.evaluate(
      (el) => (el as HTMLElement).scrollWidth - (el as HTMLElement).clientWidth,
    );
    expect(overflow, 'modal scrollWidth must equal clientWidth').toBeLessThanOrEqual(1);

    const primaryHeight = await page
      .getByTestId('about-group-primary')
      .evaluate((el) => (el as HTMLElement).getBoundingClientRect().height);
    expect(primaryHeight, 'primary group still one row when showing v9.9.9').toBeLessThanOrEqual(
      60,
    );
  });

  test('✓ Managed via Snap Store variant fits in one line and does not overflow', async ({
    page,
    serverConfig,
    app,
  }) => {
    await stubIsSnap(app, true);
    await login(page, serverConfig);
    await openAboutModal(page);

    await expect(page.getByTestId('snap-managed-indicator')).toBeVisible();

    const modal = page.getByTestId('about-modal');
    const overflow = await modal.evaluate(
      (el) => (el as HTMLElement).scrollWidth - (el as HTMLElement).clientWidth,
    );
    expect(overflow, 'modal scrollWidth must equal clientWidth').toBeLessThanOrEqual(1);

    const primaryHeight = await page
      .getByTestId('about-group-primary')
      .evaluate((el) => (el as HTMLElement).getBoundingClientRect().height);
    expect(primaryHeight, 'primary group still one row when snap-managed').toBeLessThanOrEqual(60);
  });
});
