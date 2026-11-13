import { expect, test } from './fixtures';

// A fixture AI grid member (the backend's fixtures/poc/managedclusters.json). No spec changes its
// membership; cluster-membership.spec.ts adds and removes site4.
const MEMBER = 'site1';

// UX review: at 1280 px the table was wider than the page and its actions column ended past the
// window's edge. The actions column sticks to the table's right edge, so a window too narrow for
// every column scrolls the table under it, and on a phone the table stacks.
for (const { name, width } of [
  { name: 'beside the navigation', width: 1210 },
  { name: 'on a phone', width: 390 },
]) {
  test(`keeps each row's actions in view ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/clusters');
    const table = page.getByTestId('clusters-table');
    const actions = page.getByRole('button', { name: `Actions for ${MEMBER}` });
    await expect(actions).toBeVisible();
    // Scroll the table's container to its end, as far as it goes.
    await table.evaluate((t) => {
      t.parentElement!.scrollLeft = t.parentElement!.scrollWidth;
    });
    const box = await actions.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    // The page itself never scrolls sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await actions.click();
    await expect(page.getByRole('menuitem', { name: 'Remove from AI grid' })).toBeVisible();
    await page.keyboard.press('Escape');
  });
}

// fixtures/poc/managedclusters.json gives site1 a Ready condition with this hub message.
test('opens a cluster status message from the keyboard without changing the list filter', async ({ page }) => {
  await page.goto('/clusters');
  const filter = page.getByRole('textbox', { name: 'Filter clusters' });
  await filter.fill(MEMBER);
  const status = page.getByRole('button', { name: `Ready for ${MEMBER}`, exact: true });
  await expect(status).toBeVisible();
  await status.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: `${MEMBER} Ready`, exact: true });
  await expect(dialog.getByText('Managed cluster is available', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(status).toBeFocused();
  await page.keyboard.press('Enter');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(status).toBeFocused();
  await expect(filter).toHaveValue(MEMBER);
  await expect(page.getByRole('link', { name: MEMBER, exact: true })).toBeVisible();
});
