import { expect, test } from '@playwright/test';

// The fixture AI Grid sites with coordinates (mock/fixtures-poc/managedclusters.json). The map
// can show more pins once other specs enroll another cluster, so the spec looks for these among them.
const PINS = ['San Francisco', 'New York', 'Brussels'];

test('shows the fixture pins on the bundled land outline, and a pin opens its details', async ({ page, baseURL }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto('/ai-grid');
  const map = page.getByLabel('AI Grid map of clusters');
  const pins = map.locator('path.fleet-pin');
  await expect(pins.first()).toBeVisible();
  // Labels show on hover, so they don't cover the other pins.
  await expect(map.getByText(PINS[0], { exact: true })).toHaveCount(0);
  // Each fixture site has its own pin: hovering every pin names each site.
  const named: string[] = [];
  for (const pin of await pins.all()) {
    await pin.hover({ force: true });
    // A hovered pin's label is its site name.
    named.push(((await map.locator('.leaflet-tooltip').last().textContent()) ?? '').trim());
  }
  expect(named).toEqual(expect.arrayContaining(PINS));
  // The outline's paths share the overlay pane with the pins but aren't interactive.
  await expect(
    map.locator('.leaflet-overlay-pane path.fleet-map-land:not(.leaflet-interactive)').first(),
  ).toBeAttached();
  await expect(page.getByText(/basemap/i)).toHaveCount(0);
  const origin = new URL(baseURL!).origin;
  expect(requests.filter((url) => /^https?:/.test(url) && new URL(url).origin !== origin)).toEqual([]);

  await pins.first().hover({ force: true });
  await expect(map.locator('.leaflet-tooltip').first()).toBeVisible();
  await pins.first().click({ force: true });
  await expect(page.getByRole('heading', { name: 'Site and cluster' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Models at this location' })).toBeVisible();
  await expect(map.getByText(/ · .* · Ready/).first()).toBeVisible();
});

test('monitoring switches to 24h and opens each tab', async ({ page }) => {
  await page.goto('/monitoring');
  const day = page.getByRole('button', { name: 'Last 24h' });
  await day.click();
  await expect(day).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('tab', { name: /^Cluster/ }).click();
  await expect(page.getByRole('tab', { name: /^Cluster/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Models' }).click();
  await expect(page.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Select model deployment', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Usage' }).click();
  await expect(page.getByRole('tab', { name: 'Usage' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('grid', { name: 'Organization usage' })).toBeVisible();
});
