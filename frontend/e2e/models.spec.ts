import { expect, test } from '@playwright/test';

// A fixture AI Grid member that is Ready and provisioned (mock/fixtures-poc/managedclusters.json).
const LOCATION = 'site1';

test('deploys a model to a location, edits it in the same wizard, and deletes it', async ({ page }) => {
  const unique = `e2e-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto('/models');
  await page.getByRole('link', { name: 'Deploy model' }).click();

  // Source
  await page.getByRole('textbox', { name: /^Model URI/ }).fill(`hf://e2e/${unique}`);
  await page.getByRole('button', { name: 'Next' }).click();

  // Deployment: the name starts from the model's.
  await expect(page.getByRole('textbox', { name: /^Deployment name/ })).toHaveValue(unique);
  await page.getByRole('textbox', { name: /^Runtime image/ }).fill('quay.io/example/runtime:latest');
  // The model server has no default.
  await page.getByRole('combobox', { name: 'Model server' }).selectOption({ label: 'vLLM on CPU' });
  await page.getByRole('button', { name: 'Next' }).click();

  // Locations: options read "<site name> (<location>)".
  await page.getByRole('combobox', { name: 'Locations' }).click();
  await page.getByRole('option', { name: LOCATION }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Next' }).click();

  // Review
  await expect(page.getByText(LOCATION).first()).toBeVisible();
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  await expect(page.getByText('Model deployed')).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: unique });
  await expect(row).toBeVisible();
  await expect(row.getByTestId(`model-locations-${unique}`)).toContainText(LOCATION);

  // The model's page.
  await row.getByRole('link', { name: unique, exact: true }).click();
  await expect(page.getByRole('heading', { name: unique })).toBeVisible();
  await expect(page.getByTestId('model-locations')).toContainText(LOCATION);

  // Edit in the deploy wizard: the source is read-only, every step opens directly, and Save
  // sends the change through the BFF's PATCH with the version the page loaded.
  await page.getByRole('button', { name: `Actions for ${unique}` }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await expect(page.getByRole('heading', { name: `Edit ${unique}` })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Model URI' })).toHaveAttribute('readonly', '');
  await page.getByRole('button', { name: 'Deployment', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Replicas' }).fill('2');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Model deployment updated')).toBeVisible();
  await expect(page.getByRole('heading', { name: unique })).toBeVisible();
  await expect(page.getByLabel('Deployment', { exact: true })).toContainText(/Replicas\s*2/);

  // Delete from its Actions menu.
  await page.getByRole('button', { name: `Actions for ${unique}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByLabel(/^Type .* to confirm/).fill(unique);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('Model deployment deleted')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: unique })).toHaveCount(0);
});
