import { expect, test } from '@playwright/test';

// A phone-width screen: the masthead title stays clear of the user menu, which shows only its
// icon there, and the fake-backend banner wraps inside the viewport.
test.use({ viewport: { width: 390, height: 844 } });

test('the masthead and the fake-backend banner fit a phone-width screen', async ({ page }) => {
  await page.goto('/clusters');
  const banner = page.getByText('Fake backend:');
  await expect(banner).toBeVisible();
  const menu = page.getByRole('button', { name: /^User menu: .*provider admin/ });
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('masthead-user')).toBeHidden();

  const title = await page.getByText('Cloud Provider Admin Console', { exact: true }).boundingBox();
  const user = await menu.boundingBox();
  const bar = await banner.boundingBox();
  expect(title && user && bar).toBeTruthy();
  // At least the spacer--sm gap (8px) between them.
  expect(title!.x + title!.width + 8).toBeLessThanOrEqual(user!.x);
  expect(bar!.x + bar!.width).toBeLessThanOrEqual(390);
});

test.describe('on a laptop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a loading page shows its spinner in the middle of the page', async ({ page }) => {
    // Never answer the clusters request, so the Clusters page stays loading.
    await page.route('**/api/v1/clusters**', () => undefined);
    await page.goto('/clusters');
    const spinner = page.getByRole('progressbar', { name: 'Loading clusters' });
    await expect(spinner).toBeVisible();
    const box = (await spinner.boundingBox())!;
    const section = (await spinner.locator('xpath=ancestor::section[1]').boundingBox())!;
    const centre = (start: number, size: number) => start + size / 2;
    expect(Math.abs(centre(box.x, box.width) - centre(section.x, section.width))).toBeLessThanOrEqual(2);
    expect(Math.abs(centre(box.y, box.height) - centre(section.y, section.height))).toBeLessThanOrEqual(2);
    // The section fills the rest of the page below the header, not just the spinner's height.
    expect(section.height).toBeGreaterThan(400);
  });

  test('the masthead shows the console name on one line, level with the signed-in user', async ({ page }) => {
    await page.goto('/clusters');
    const heading = page.getByText('Cloud Provider Admin Console', { exact: true });
    const name = page.getByTestId('masthead-user');
    await expect(name).toBeVisible();
    await expect(name).toContainText('provider admin');

    const title = await heading.boundingBox();
    const user = await name.boundingBox();
    expect(title && user).toBeTruthy();
    const lineHeight = await heading.evaluate((h) => parseFloat(getComputedStyle(h).lineHeight));
    // One line: the name no longer wraps to the sidebar's width.
    expect(title!.height).toBeLessThan(lineHeight * 1.5);
    expect(title!.x + title!.width + 8).toBeLessThanOrEqual(user!.x);
    // Centred on the same line as the menu.
    expect(Math.abs(title!.y + title!.height / 2 - (user!.y + user!.height / 2))).toBeLessThanOrEqual(2);
  });
});
