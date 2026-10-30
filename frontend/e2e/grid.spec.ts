import { expect, test, type Locator } from '@playwright/test';

// Runs on the backend's own fakes (playwright.config.ts): the map reads Clusters/List over Connect.
// The fixture AI Grid sites with coordinates (the backend's fixtures/poc/managedclusters.json). The map
// can show more pins once other specs enroll another cluster, so the spec looks for these among them.
const PINS = ['San Francisco · site1', 'New York · site2', 'Brussels · site3'];

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
  const tooltip = map.locator('.leaflet-tooltip');
  // Leaflet fades a closed label out, so move off the pins and wait for it to go before the next.
  const hover = async (pin: Locator) => {
    await page.mouse.move(0, 0);
    await expect(tooltip).toHaveCount(0);
    await pin.hover();
    await expect(tooltip).toHaveCount(1);
  };
  for (const pin of await pins.all()) {
    await hover(pin);
    // A hovered pin's label is its site name and its cluster's.
    named.push(((await tooltip.textContent()) ?? '').trim());
  }
  expect(named).toEqual(expect.arrayContaining(PINS));
  // The outline's paths share the overlay pane with the pins but aren't interactive.
  await expect(
    map.locator('.leaflet-overlay-pane path.fleet-map-land:not(.leaflet-interactive)').first(),
  ).toBeAttached();
  await expect(page.getByText(/basemap/i)).toHaveCount(0);
  const origin = new URL(baseURL!).origin;
  expect(requests.filter((url) => /^https?:/.test(url) && new URL(url).origin !== origin)).toEqual([]);

  await hover(pins.first());
  await expect(tooltip).toBeVisible();
  await pins.first().click();
  await expect(page.getByRole('heading', { name: 'Cluster', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Models on this cluster' })).toBeVisible();
  await expect(map.getByText(/ · .* · Ready/).first()).toBeVisible();
});
