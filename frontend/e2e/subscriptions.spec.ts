import { create, fromJsonString, toJsonString } from '@bufbuild/protobuf';
import { ModelsListResponseSchema } from '../src/gen/ai_grid/v1/models_service_pb';
import { ModelClusterStatusSchema, ModelState, ModelStatusSchema } from '../src/gen/ai_grid/v1/model_type_pb';
import { expect, test } from './fixtures';
import { createModel, createdSubscriptionId, tryBackend, writeConfirmed } from './backend';

// On the backend's own fakes (playwright.config.ts, "backend fakes"): the pages read and write the
// backend's Subscriptions API over Connect. The organization is the PoC's in the backend's fake
// Keycloak (fixtures/poc/organizations.json). The Git catalog starts empty, so the spec commits a
// model of its own first and takes it out again (e2e/backend.ts).
const ORGANIZATION = 'acme-robotics';

test('creates, views, edits and deletes a subscription', async ({ page }) => {
  const unique = `e2e-${Math.random().toString(36).slice(2, 8)}`;
  const group = `${unique}-team`;
  const modelId = `${unique}-model`;
  const MODEL = `E2E model ${unique}`;
  await createModel(page.request, modelId, MODEL);
  // The fake hub doesn't report deployments for newly created models. Supply the read-only
  // rollout report at the Connect boundary; subscription writes still reach the real backend.
  await page.route('**/ai_grid.v1.Models/List*', async (route) => {
    const response = await route.fetch();
    const answer = fromJsonString(ModelsListResponseSchema, await response.text());
    const model = answer.items.find((item) => item.id === modelId);
    if (model) {
      model.status ??= create(ModelStatusSchema);
      model.status.state = ModelState.PARTIALLY_READY;
      model.status.clusters = [
        create(ModelClusterStatusSchema, { cluster: 'site1', state: ModelState.READY }),
        create(ModelClusterStatusSchema, { cluster: 'site2', state: ModelState.STARTING, message: 'Starting model' }),
      ];
    }
    await route.fulfill({ response, body: toJsonString(ModelsListResponseSchema, answer) });
  });
  // The id the backend gives the subscription: `unique`, or `unique` with a suffix (backend PR 89).
  let id = unique;
  try {
    await page.goto('/subscriptions');
    await page.getByRole('link', { name: 'Create subscription' }).click();

    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(unique);
    await page.getByRole('combobox', { name: 'Organization' }).click();
    await page.getByRole('option', { name: ORGANIZATION }).click();
    await page.getByRole('combobox', { name: 'Groups' }).fill(group);
    await page.getByRole('option', { name: `Add group "${group}"` }).click();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Add models' }).click();
    const addModels = page.getByRole('dialog', { name: 'Add models', exact: true });
    await addModels.getByRole('checkbox', { name: `Select ${MODEL}` }).check();
    const statusTrigger = addModels.getByRole('button', { name: `Partially ready for ${MODEL}`, exact: true });
    await statusTrigger.click();
    const statusDialog = page.getByRole('dialog', { name: `${MODEL} status`, exact: true });
    await expect(statusDialog).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(statusDialog).toContainText('The model isn’t ready on one or more of its clusters.');
    const clusters = statusDialog.getByRole('grid', { name: `Clusters of ${MODEL}`, exact: true });
    await expect(clusters.getByRole('columnheader')).toHaveText(['Cluster', 'Site', 'Region', 'Status', 'View']);
    // The backend fakes' hub gives site2 a site name and no region.
    await expect(
      clusters.getByRole('row', { name: 'site2 New York — Starting on site2 —', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(addModels).toBeVisible();
    await expect(statusTrigger).toBeFocused();
    await expect(addModels.getByRole('checkbox', { name: `Select ${MODEL}` })).toBeChecked();
    await addModels.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: `Partially ready for ${MODEL}`, exact: true }).click();
    await expect(statusDialog).toBeVisible();
    await statusDialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(unique);
    await page.getByRole('button', { name: 'Add token limit' }).click();
    const limits = page.getByRole('dialog', { name: 'Edit token limits' });
    await limits.getByRole('spinbutton', { name: 'Tokens' }).fill('5000');
    await limits.getByRole('button', { name: 'Save' }).click();
    const created = createdSubscriptionId(page);
    await page.getByRole('button', { name: 'Create subscription' }).click();
    id = (await created) ?? unique;
    await expect(writeConfirmed(page, `Subscription ${unique} saved to Git`)).toBeVisible();

    // The phase is the backend's: Pending while a cluster's catalog Application doesn't list the
    // subscription, as site3's static one doesn't list a new one (maasPhase,
    // internal/servers/subscriptions_git.go, and the backend's fixtures/poc/applications.json).
    const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: unique, exact: true }) });
    await expect(row.getByTestId('phase-label')).toHaveText('Pending');

    // The view page opens directly and survives a reload.
    await page.goto(`/subscriptions/view/${id}`);
    await expect(page.getByRole('heading', { level: 1, name: unique, exact: true })).toBeVisible();
    await expect(page.getByText(ORGANIZATION).first()).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: unique, exact: true })).toBeVisible();
    await expect(page.getByRole('grid', { name: 'subscription models' })).toContainText('5,000');
    await expect(page.getByTestId('subscription-priority')).toHaveText('0');

    // Edit the priority.
    await page.getByRole('button', { name: `Actions for ${unique}` }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    await expect(page).toHaveURL(new RegExp(`/subscriptions/edit/${id}$`));
    await page.getByRole('spinbutton', { name: 'Priority' }).fill('42');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(writeConfirmed(page, `Changes to subscription ${unique} saved to Git`)).toBeVisible();

    // Delete from the list with the typed confirmation.
    await expect(row).toContainText('42');
    await row.getByRole('button', { name: `Actions for ${unique}` }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByLabel(/^Type .* to confirm/).fill(unique);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(row).toHaveCount(0);
  } finally {
    // Whatever step failed, the catalog is left as it was: the subscription, if it is still there
    // (zero skips the version check), then the model.
    await tryBackend(page.request, 'Subscriptions/Delete', { id });
    await tryBackend(page.request, 'Models/Delete', { id: modelId });
  }
});

// The fake hub's catalog Argo CD Applications report subscription team-a and its policy
// team-a-policy active on site3, the PoC's one ingress cluster, and every other subscription not
// there yet (fixtures/poc/applications.json in the backend), so a subscription created as team-a
// reads Active as soon as it is in Git: the notification center's watch says so on its first read.
// A backend that adds a suffix to the name (backend PR 89) answers team-a-<suffix>, which these
// fixtures don't report; the watch follows the answered id, so this test needs fixtures that report
// that name before the console moves to such a backend.
const ACTIVE_ID = 'team-a';

test('says a created subscription is active once the ingress clusters report it', async ({ page }) => {
  const unique = `e2e-${Math.random().toString(36).slice(2, 8)}`;
  const modelId = `${unique}-model`;
  const MODEL = `E2E model ${unique}`;
  // A team-a a failed run left behind would refuse the create.
  await tryBackend(page.request, 'Subscriptions/Delete', { id: ACTIVE_ID });
  await createModel(page.request, modelId, MODEL);
  let id = ACTIVE_ID;
  try {
    await page.goto('/subscriptions/create');
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(ACTIVE_ID);
    await page.getByRole('combobox', { name: 'Organization' }).click();
    await page.getByRole('option', { name: ORGANIZATION }).click();
    await page.getByRole('combobox', { name: 'Groups' }).fill(`${unique}-team`);
    await page.getByRole('option', { name: `Add group "${unique}-team"` }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Add models' }).click();
    const addModels = page.getByRole('dialog');
    await addModels.getByRole('checkbox', { name: `Select ${MODEL}` }).check();
    await addModels.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Add token limit' }).click();
    await page.getByRole('dialog', { name: 'Edit token limits' }).getByRole('button', { name: 'Save' }).click();
    const created = createdSubscriptionId(page);
    await page.getByRole('button', { name: 'Create subscription' }).click();
    id = (await created) ?? ACTIVE_ID;
    await expect(writeConfirmed(page, `Subscription ${ACTIVE_ID} saved to Git`)).toBeVisible();

    // The toast, wherever the admin is, and the drawer's entry, unread, with the organization's name.
    await page.getByRole('link', { name: 'Clusters', exact: true }).click();
    const active = `Subscription ${ACTIVE_ID} is active`;
    await expect(page.getByRole('heading', { name: `Success alert: ${active}`, exact: true })).toBeVisible();
    // One unread entry, or two when the create outlasted the form's wait (its outcome arrives unread too).
    await page.getByRole('button', { name: /^Notifications, [12] unread$/ }).click();
    const entry = page.getByRole('list', { name: 'Notifications' }).getByRole('listitem').filter({ hasText: active });
    await expect(entry).toContainText(`Users in its groups in the ${ORGANIZATION} organization can use its models.`);

    // The list shows the phase the watch saw.
    await page.goto('/subscriptions');
    const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: ACTIVE_ID, exact: true }) });
    await expect(row.getByTestId('phase-label')).toHaveText('Active');
  } finally {
    await tryBackend(page.request, 'Subscriptions/Delete', { id });
    await tryBackend(page.request, 'Models/Delete', { id: modelId });
  }
});
