import { expect, test } from './fixtures';

// Runs on the backend's own fakes (playwright.config.ts), where every page has data to show. Every
// spec already fails on a Content-Security-Policy violation (e2e/fixtures.ts); this one visits each
// page of the console, in both themes, and checks that the policy is the one in force.

const pages = [
  { path: '/ai-grid', heading: 'AI grid' },
  { path: '/clusters', heading: 'Clusters' },
  { path: '/organizations', heading: 'Organizations' },
  { path: '/organizations/create', heading: 'Create organization' },
  { path: '/models', heading: 'Models' },
  { path: '/models/deploy', heading: 'Deploy model' },
  { path: '/subscriptions', heading: 'Subscriptions' },
  { path: '/subscriptions/create', heading: 'Create subscription' },
];

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`in the ${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('every page loads without a Content-Security-Policy violation', async ({ page }) => {
      for (const { path, heading } of pages) {
        const response = await page.goto(path);
        // Without script-src the policy would not hold back scripts at all, so check it is there.
        expect(response?.headers()['content-security-policy'], path).toContain("script-src 'self';");
        await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
      }

      // The map draws its outline and pins, and a pin's label.
      await page.goto('/ai-grid');
      const pin = page.getByLabel('AI grid map of clusters').locator('path.fleet-pin').first();
      await expect(pin).toBeVisible();
      await pin.hover();
      await expect(page.locator('.leaflet-tooltip')).toBeVisible();

      // A details page, and the notification drawer over it.
      await page.goto('/clusters');
      await page.getByRole('link', { name: 'site1', exact: true }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'site1', exact: true })).toBeVisible();
      await page.getByRole('button', { name: /^Notifications/ }).click();
      await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
    });
  });
}

// The check above passes only if a violation would be noticed: markup put into a page cannot run
// script, and the page reports the attempt.
test('a page refuses an inline script and an inline event handler', async ({ page, policyViolations }) => {
  await page.goto('/clusters');
  await expect(page.getByRole('heading', { level: 1, name: 'Clusters', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.setAttribute('onclick', 'document.body.dataset.inlineHandlerRan = "true"');
    document.body.append(button);
    button.click();
    const script = document.createElement('script');
    script.textContent = 'document.body.dataset.inlineScriptRan = "true"';
    document.body.append(script);
  });
  await expect
    .poll(() => policyViolations.map((v) => v.directive).sort())
    .toEqual(['script-src-attr', 'script-src-elem']);
  expect(await page.evaluate(() => ({ ...document.body.dataset }))).toEqual({});
  // Expected here; any other test fails on them.
  policyViolations.length = 0;
});
