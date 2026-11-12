import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { callBackend as call } from './backend';

// Edit on the backend's own fakes (its fixtures/poc), through the BFF's Connect relay. The fixtures
// give no member a role: this spec gives site2 the inference role first, as Add to AI Grid writes
// it, and edits its location label in the browser (its role is then read-only), and sets a role on
// site3 in the browser. It puts both clusters' labels back afterwards: its project in
// playwright.config.ts runs one test at a time, so the other specs see them as the fixture has them.
// Both roles are inference: the backend refuses to take ingress away from AI Grid's only ingress
// cluster while other members stay (docs/connect.md, "The backend's role rules"), so an ingress role
// given here could not be put back.
const WITH_ROLE = 'site2';
const WITHOUT_ROLE = 'site3';

type Labels = Record<string, string>;
type Cluster = { object: { metadata: { labels?: Labels; version?: number } } };

const labelsOf = async (request: APIRequestContext, id: string) =>
  (await call<Cluster>(request, 'Clusters/Get', { id })).object.metadata;

/** Writes the cluster's labels whole, at the version read (Clusters/Update with lock). */
const writeLabels = async (request: APIRequestContext, id: string, labels: Labels) => {
  const { version } = await labelsOf(request, id);
  await call(request, 'Clusters/Update', {
    object: { id, metadata: { labels, version } },
    updateMask: 'metadata.labels',
    lock: true,
  });
};

const original: Record<string, Labels> = {};

test.beforeAll(async ({ request }) => {
  for (const id of [WITH_ROLE, WITHOUT_ROLE]) original[id] = { ...(await labelsOf(request, id)).labels };
  await writeLabels(request, WITH_ROLE, { ...original[WITH_ROLE], 'ai-grid/role': 'inference' });
});

test.afterAll(async ({ request }) => {
  for (const id of [WITH_ROLE, WITHOUT_ROLE]) await writeLabels(request, id, original[id]);
});

const openEdit = async (page: Page, cluster: string) => {
  // The menu appears once /user has answered.
  await page.getByRole('button', { name: `Actions for ${cluster}` }).click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  return page.getByRole('dialog', { name: 'Edit AI Grid cluster' });
};

const rowOf = (page: Page, cluster: string) =>
  page.getByRole('row').filter({ has: page.getByRole('gridcell', { name: cluster, exact: true }) });

test("edits a cluster's location label, and sets the role of a cluster without one", async ({ page }) => {
  await page.goto('/clusters');

  // A cluster with a role: only its location label can be edited.
  let dialog = await openEdit(page, WITH_ROLE);
  const role = dialog.getByRole('textbox', { name: 'Role' });
  await expect(role).toHaveValue('Inference');
  await expect(role).toHaveAttribute('readonly', '');
  await expect(dialog.getByRole('textbox', { name: 'Location label' })).toHaveValue(WITH_ROLE);
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Location label' }).fill('us-east-edge');
  await dialog.getByRole('button', { name: 'Save' }).click();
  // A location label installs nothing, so nothing is promised or followed.
  await expect(page.getByText(`Changes to cluster ${WITH_ROLE} saved`)).toBeVisible();
  await expect(page.getByText("You'll be notified when it's provisioned.")).toHaveCount(0);

  // A cluster without a role: the dialog says what the hub installs, and asks for no name.
  dialog = await openEdit(page, WITHOUT_ROLE);
  await dialog.getByRole('combobox', { name: 'Role' }).click();
  await page.getByRole('option', { name: /^Inference/ }).click();
  const change = dialog.getByTestId('cluster-role-change');
  await expect(change).toContainText('What the hub installs');
  await expect(change).toContainText(
    'Saving sets the role to Inference. The hub then installs KServe model serving, the provider gateway, and the GPU operators on this cluster.',
  );
  await expect(dialog.getByRole('textbox', { name: new RegExp(`^Type ${WITHOUT_ROLE} to confirm`) })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`Changes to cluster ${WITHOUT_ROLE} saved`)).toBeVisible();
  await expect(
    page.getByText("The hub is installing what its Inference role needs. You'll be notified when it's provisioned."),
  ).toBeVisible();
  // The notification center follows the hub's ready check (Clusters/Get). The fake hub reports
  // site3 Compliant from the start (its fixture's ai-grid/provisioned label), so the first read
  // already finds it provisioned; a cluster really installing would take minutes.
  await expect(page.getByText(`Cluster ${WITHOUT_ROLE} is provisioned`)).toBeVisible();
  await expect(
    page.getByText('The hub reports OpenShift AI ready on it. You can select it when you deploy a model.'),
  ).toBeVisible();

  // The backend kept both: the list after a reload, then the clusters' pages.
  await page.reload();
  await expect(rowOf(page, WITH_ROLE)).toContainText('us-east-edge');
  await expect(rowOf(page, WITH_ROLE)).toContainText('Inference');
  await expect(rowOf(page, WITHOUT_ROLE)).toContainText('Inference');

  await rowOf(page, WITH_ROLE).getByRole('link', { name: WITH_ROLE, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: WITH_ROLE })).toBeVisible();
  await expect(page.getByLabel('AI Grid membership')).toContainText('us-east-edge');

  await page.goto(`/clusters/${WITHOUT_ROLE}`);
  await expect(page.getByRole('heading', { level: 1, name: WITHOUT_ROLE })).toBeVisible();
  await expect(page.getByLabel('AI Grid membership')).toContainText('Inference');
});
