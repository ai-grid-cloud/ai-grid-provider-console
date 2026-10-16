import { expect, test } from '@playwright/test';

// The fixture cluster that is not yet an AI Grid member (mock/fixtures-poc/managedclusters.json).
const ENROLLABLE = 'site4';

// The fake keeps its state in memory and the site is fixed, so a rerun against a reused
// server finds it already enrolled: the spec adapts instead of requiring a fresh server.
test.describe.configure({ mode: 'serial' });

test('adds an enrollable cluster to the AI Grid and keeps it after a reload', async ({ page }) => {
  await page.goto('/clusters');
  const row = page.getByRole('row').filter({ has: page.getByRole('gridcell', { name: ENROLLABLE, exact: true }) });
  await expect(row).toBeVisible();

  const add = page.getByRole('button', { name: `Add ${ENROLLABLE} to AI Grid` });
  // The button appears once /user has answered; a member shows no button at all.
  await expect(add.or(row.getByText('AI Grid Member'))).toBeVisible();
  if (await add.isVisible()) {
    await add.click();
    await expect(page.getByText(`${ENROLLABLE} added to AI Grid`)).toBeVisible();
  }
  await expect(row.getByText('AI Grid Member')).toBeVisible();
  await expect(row.getByRole('gridcell', { name: 'Member', exact: true })).toBeVisible();

  await page.reload();
  const reloaded = page.getByRole('row').filter({ has: page.getByRole('gridcell', { name: ENROLLABLE, exact: true }) });
  await expect(reloaded.getByText('AI Grid Member')).toBeVisible();
  await expect(page.getByRole('button', { name: `Add ${ENROLLABLE} to AI Grid` })).toHaveCount(0);
});
