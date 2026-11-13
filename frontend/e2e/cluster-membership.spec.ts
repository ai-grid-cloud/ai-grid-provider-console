import { expect, test } from './fixtures';

// The fixture cluster that is not yet an AI grid member (the backend's fixtures/poc/managedclusters.json).
const ENROLLABLE = 'site4';

// The one spec that changes a fixture object, so it puts it back: it adds site4 to AI grid and
// removes it again. Its project in playwright.config.ts runs one test at a time, so two runs of it
// (--repeat-each) never change site4 at once. It adds site4 as Inference: the backend refuses to
// remove AI grid's only ingress cluster while other members stay (docs/connect.md, "The backend's
// role rules"), and the fixtures give no member a role, so site4 added as Ingress or Combined could
// not be removed again.
test('adds an enrollable cluster to the AI grid, keeps it after a reload, and removes it', async ({ page }) => {
  await page.goto('/clusters');
  const row = page.getByRole('row').filter({ has: page.getByRole('gridcell', { name: ENROLLABLE, exact: true }) });
  await expect(row.locator('[data-label="AI grid status"]')).toHaveText('—');

  // The add button appears once /user has answered.
  await row.getByRole('button', { name: `Add ${ENROLLABLE} to AI grid` }).click();
  // The location is prefilled from the cluster's label; the role has to be chosen.
  const add = page.getByRole('dialog', { name: 'Add cluster to AI grid' });
  await expect(add.getByRole('textbox', { name: 'Location label' })).toHaveValue(ENROLLABLE);
  await add.getByRole('combobox', { name: 'Role' }).click();
  await page.getByRole('option', { name: /^Inference/ }).click();
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(`Cluster ${ENROLLABLE} added to AI grid`)).toBeVisible();
  await expect(
    page.getByText("The hub is installing what its Inference role needs. You'll be notified when it's provisioned."),
  ).toBeVisible();

  // A member the hub hasn't provisioned yet (the fixture's ai-grid/provisioned is "false", which
  // the fake hub's ready check reports NonCompliant for good, so the watch never says provisioned).
  await page.reload();
  await expect(row).toContainText('Provisioning');
  // The notification survives the reload, kept in the tab.
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Notifications' })).toContainText(
    `Cluster ${ENROLLABLE} added to AI grid`,
  );
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();

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
  await page.getByRole('menuitem', { name: 'Remove from AI grid' }).click();
  const remove = page.getByRole('dialog', { name: `Remove ${ENROLLABLE} from AI grid?` });
  await remove.getByRole('textbox', { name: `Type ${ENROLLABLE} to confirm:` }).fill(ENROLLABLE);
  await remove.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText(`Cluster ${ENROLLABLE} removed from AI grid`)).toBeVisible();
  // A cluster outside AI grid shows the summary and Add, not the membership list.
  await expect(
    page.getByText(
      'The AI grid connects your OpenShift clusters into a unified network to serve models and route traffic across locations.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to AI grid' })).toBeVisible();
  await expect(page.getByTestId('cluster-membership')).toHaveCount(0);
  // The fake hub's ready check stops listing a cluster as soon as it leaves, so the watch's first
  // read finds it gone; it arrives after the click, so unread.
  await expect(page.getByText(`Cluster ${ENROLLABLE} left AI grid`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Notifications, 1 unread' })).toBeVisible();
});
