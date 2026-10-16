import { expect, test } from '@playwright/test';

// The fixture AI Grid sites with coordinates (mock/fixtures-poc/managedclusters.json). The map
// can show more pins once other specs enroll another cluster, so the spec checks these by name.
const PINS = ['San Francisco', 'New York', 'Brussels'];

test.beforeEach(async ({ page }) => {
  // CI doesn't depend on the Esri basemap; blocked tiles must leave pins and the list usable.
  await page.route('**://server.arcgisonline.com/**', (route) => route.abort());
});

test('shows the fixture pins, the tile notice, and a pin opens its details', async ({ page }) => {
  await page.goto('/ai-grid');
  const map = page.getByLabel('AI Grid map of clusters');
  // Leaflet briefly duplicates tooltips after load, so these locators take the first match.
  for (const pin of PINS) {
    await expect(map.getByText(pin, { exact: true }).first()).toBeVisible();
  }
  await expect(
    page.getByText('Basemap tiles unavailable. Cluster pins and the cluster list remain available.'),
  ).toBeVisible();

  await map.locator('path.leaflet-interactive').first().click({ force: true });
  await expect(page.getByText('Site and cluster')).toBeVisible();
  await expect(page.getByText('Models at this location')).toBeVisible();
  await expect(map.getByText(/ · .* · Ready/).first()).toBeVisible();
});

test('monitoring switches to 24h and opens each tab', async ({ page }) => {
  await page.goto('/monitoring');
  const day = page.getByRole('button', { name: 'Last 24h' });
  await day.click();
  await expect(day).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('tab', { name: 'Cluster' }).click();
  await expect(page.getByRole('tab', { name: 'Cluster' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Models' }).click();
  await expect(page.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Select model deployment')).toBeVisible();
  await page.getByRole('tab', { name: 'Usage' }).click();
  await expect(page.getByRole('tab', { name: 'Usage' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('table', { name: 'Organization usage' })).toBeVisible();
});
