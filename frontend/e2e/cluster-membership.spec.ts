import { expect, test } from '@playwright/test';

// The fixture cluster that is not yet an AI Grid member (the backend's fixtures/poc/managedclusters.json).
const ENROLLABLE = 'site4';

// The one spec that changes a fixture object, so it puts it back: it adds site4 to AI Grid and
// removes it again. Its project in playwright.config.ts runs one test at a time, so two runs of it
// (--repeat-each) never change site4 at once.
test('adds an enrollable cluster to the AI Grid, keeps it after a reload, and removes it', async ({ page }) => {
  await page.goto('/clusters');
  const row = page.getByRole('row').filter({ has: page.getByRole('gridcell', { name: ENROLLABLE, exact: true }) });
  await expect(row).toContainText('Not added');

  // The menu appears once /user has answered.
  await page.getByRole('button', { name: `Actions for ${ENROLLABLE}` }).click();
  await page.getByRole('menuitem', { name: 'Add to AI Grid' }).click();
  // The location is prefilled from the cluster's label; the role has to be chosen.
  const add = page.getByRole('dialog', { name: `Add ${ENROLLABLE} to AI Grid?` });
  await expect(add.getByRole('textbox', { name: 'Location label' })).toHaveValue(ENROLLABLE);
  await add.getByRole('combobox', { name: 'Role' }).click();
  await page.getByRole('option', { name: /Combined/ }).click();
  await add.getByRole('button', { name: 'Add to AI Grid' }).click();
  await expect(page.getByText(`${ENROLLABLE} added to AI Grid`)).toBeVisible();

  // A member the hub hasn't provisioned yet (the fixture's ai-grid/provisioned is "false").
  await page.reload();
  await expect(row).toContainText('Provisioning');

  // The name opens the cluster's details page, with what the hub reports about it.
  await row.getByRole('link', { name: ENROLLABLE, exact: true }).click();
  await expect(page).toHaveURL(`/clusters/${ENROLLABLE}`);
  await expect(page.getByRole('heading', { level: 1, name: ENROLLABLE })).toBeVisible();
  await expect(page.getByTestId('cluster-membership')).toContainText('Provisioning');
  await expect(page.getByLabel('Cluster', { exact: true })).toContainText('v1.35.6');
  await expect(page.getByTestId('cluster-gpus')).toHaveText('16');
  await expect(page.getByTestId('cluster-status')).toContainText('Ready');
  await expect(page.getByRole('link', { name: 'OpenShift console' })).toHaveAttribute('target', '_blank');

  // Remove it from its details page, which leaves site4 as the fixture has it.
  await page.getByRole('button', { name: `Actions for ${ENROLLABLE}` }).click();
  await page.getByRole('menuitem', { name: 'Remove from AI Grid' }).click();
  const remove = page.getByRole('dialog', { name: `Remove ${ENROLLABLE} from AI Grid?` });
  await remove.getByRole('textbox', { name: `Type ${ENROLLABLE} to confirm:` }).fill(ENROLLABLE);
  await remove.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText(`${ENROLLABLE} removed from AI Grid`)).toBeVisible();
  await expect(page.getByTestId('cluster-membership')).toContainText('Not added');
});
