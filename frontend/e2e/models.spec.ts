import { expect, test } from '@playwright/test';

// A fixture AI Grid member that is Ready and provisioned (mock/fixtures-poc/managedclusters.json).
const LOCATION = 'site1';

const unique = `e2e-${Math.random().toString(36).slice(2, 8)}`;

test('deploys a model to a location, expands its locations and deletes it', async ({ page }) => {
  await page.goto('/models');
  await page.getByRole('link', { name: 'Deploy model' }).click();

  // Model details
  await page.getByRole('textbox', { name: /^Model URI/ }).fill(`hf://e2e/${unique}`);
  await page.getByRole('textbox', { name: /^Model name/ }).fill(`e2e/${unique}`);
  await page.getByRole('button', { name: 'Next' }).click();

  // Model deployment
  await page.getByRole('textbox', { name: /^Model deployment name/ }).fill(unique);
  await page.getByRole('textbox', { name: /^Runtime image/ }).fill('quay.io/example/runtime:latest');
  await page.getByRole('button', { name: 'Next' }).click();

  // Advanced options
  await page.getByRole('button', { name: 'Next' }).click();

  // Locations
  await page.getByRole('combobox', { name: 'Locations' }).click();
  await page.getByRole('option', { name: LOCATION }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Next' }).click();

  // Review
  await expect(page.getByText(LOCATION).first()).toBeVisible();
  await page.getByRole('button', { name: 'Save deployment' }).click();
  await expect(page.getByText('Model deployment saved')).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: unique });
  await expect(row).toBeVisible();
  await row.getByTestId(`model-locations-expand-${unique}`).getByRole('button').click();
  // The panel can render twice for a moment after the expand, so match on the first one.
  await expect(page.getByTestId('locations-expanded-panel').first()).toContainText(LOCATION);

  await page.getByRole('button', { name: `Actions for ${unique}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByLabel('Delete modal input').fill(unique);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: unique })).toHaveCount(0);
});
