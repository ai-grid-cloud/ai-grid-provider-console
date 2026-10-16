import { expect, test } from '@playwright/test';

const unique = `e2e-${Math.random().toString(36).slice(2, 8)}`;
const domain = `${unique}.example.com`;
const editedDomain = `edited-${unique}.example.com`;
const issuer = `https://idp.${domain}/realms/main`;

test('creates, views, edits and deletes an organization', async ({ page }) => {
  await page.goto('/organizations');
  await page.getByRole('link', { name: 'Create organization' }).click();

  // Step 1: details
  await page.getByRole('textbox', { name: /^Name/ }).fill(unique);
  await page.getByRole('button', { name: 'Add domain' }).click();
  await page.getByRole('textbox', { name: /^Domain 1/ }).fill(domain);
  await page.getByRole('button', { name: 'Next' }).click();

  // Step 2: identity provider
  await page.getByRole('textbox', { name: /^Client ID/ }).fill('console');
  await page.getByRole('textbox', { name: /^Client secret reference/ }).fill('idp-secret');
  await page.getByRole('textbox', { name: /^Issuer/ }).fill(issuer);
  await page.getByRole('textbox', { name: /^Authorization URL/ }).fill(`${issuer}/auth`);
  await page.getByRole('textbox', { name: /^Token URL/ }).fill(`${issuer}/token`);
  await page.getByRole('button', { name: 'Next' }).click();

  // Step 3: review
  await expect(page.getByText(issuer).first()).toBeVisible();
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByText('Organization and identity provider saved')).toBeVisible();

  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: unique, exact: true }) });
  await expect(row).toContainText(domain);

  // View
  await row.getByRole('link', { name: unique, exact: true }).click();
  await expect(page.getByRole('heading', { name: unique })).toBeVisible();
  await expect(page.getByText(domain).first()).toBeVisible();

  // Edit a domain; the deep link and reload land on the same page.
  await page.getByRole('link', { name: 'Edit organization' }).click();
  await expect(page).toHaveURL(/\/organizations\/[^/]+\/edit$/);
  await page.reload();
  await page.getByRole('textbox', { name: /^Domain 1/ }).fill(editedDomain);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Organization configuration saved')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: unique })).toContainText(editedDomain);

  // Delete with the typed confirmation
  await page.getByRole('button', { name: `Actions for ${unique}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('button', { name: 'Delete', exact: true });
  await expect(confirm).toBeDisabled();
  await page.getByLabel('Delete modal input').fill(unique);
  await confirm.click();
  await expect(page.getByRole('link', { name: unique, exact: true })).toHaveCount(0);
});
