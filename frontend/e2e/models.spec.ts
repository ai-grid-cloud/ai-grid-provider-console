import type { APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures';
import { callBackend as call, createModel, tryBackend, writeConfirmed } from './backend';

// The backend's own Models API on its fakes (the backend's fixtures/poc), through the BFF's
// Connect relay. site1 is an Available member, Compliant with the ready Policy; the fixtures give
// no cluster an ai-grid/role, so Models/ListPlacementClusters offers none until one serves models.
// This spec gives site1 the inference role for its run, as Add to AI grid writes it, and puts its
// labels back afterwards: its project in playwright.config.ts runs one test at a time.
const CLUSTER = 'site1';

type Labels = Record<string, string>;

type Cluster = { object: { metadata: { labels?: Labels; version?: number } } };

/** Writes the cluster's labels whole, at the version read (Clusters/Update with lock). */
const writeLabels = async (request: APIRequestContext, change: (labels: Labels) => Labels) => {
  const { object } = await call<Cluster>(request, 'Clusters/Get', { id: CLUSTER });
  await call(request, 'Clusters/Update', {
    object: {
      id: CLUSTER,
      metadata: { labels: change({ ...object.metadata.labels }), version: object.metadata.version },
    },
    updateMask: 'metadata.labels',
    lock: true,
  });
};

let originalRole: string | undefined;

test.beforeAll(async ({ request }) => {
  await writeLabels(request, (labels) => {
    originalRole = labels['ai-grid/role'];
    return { ...labels, 'ai-grid/role': 'inference' };
  });
});

test.afterAll(async ({ request }) => {
  await writeLabels(request, (labels) => {
    const next = { ...labels };
    if (originalRole === undefined) delete next['ai-grid/role'];
    else next['ai-grid/role'] = originalRole;
    return next;
  });
});

test('deploys a model to a cluster, edits it in the same wizard, and deletes it', async ({ page }) => {
  const unique = `e2e-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto('/models');
  await page.getByRole('link', { name: 'Deploy model' }).click();

  // Source
  await page.getByRole('textbox', { name: /^Model URI/ }).fill(`hf://e2e/${unique}`);
  await page.getByRole('button', { name: 'Next' }).click();

  // Deployment: the name starts from the model URI's last segment.
  await expect(page.getByRole('textbox', { name: /^Model name/ })).toHaveValue(unique);
  // Hardware: NVIDIA GPU first, from the console's default list. CPU only fills in its own image: the
  // cluster's default image is for NVIDIA GPUs, so off them the image is required.
  await expect(page.getByRole('radio', { name: 'NVIDIA GPU' })).toBeChecked();
  await page.getByRole('radio', { name: 'CPU only' }).check();
  await expect(page.getByRole('textbox', { name: /^Runtime image/ })).toHaveValue(
    /^registry\.redhat\.io\/rhaii\/vllm-cpu-rhel9@/,
  );
  await expect(page.getByRole('textbox', { name: /^Runtime image/ })).toHaveAttribute('required');
  await page.getByRole('button', { name: 'Next' }).click();

  // Clusters: options read the cluster name, then its site and region, from Models/ListPlacementClusters.
  await page.getByRole('combobox', { name: 'Clusters' }).click();
  await page.getByRole('option', { name: CLUSTER }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Next' }).click();

  // Review: users call the model by its resource name.
  await expect(page.getByText(CLUSTER).first()).toBeVisible();
  await expect(page.getByTestId('model-review')).toContainText(`Model name in requests${unique}`);
  await expect(page.getByTestId('model-review')).toContainText('HardwareCPU only');
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  await expect(writeConfirmed(page, `Model ${unique} saved to Git`)).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: unique });
  await expect(row).toBeVisible();
  // The backend saved it to Git; no cluster has reported it yet.
  const status = row.getByRole('button', { name: `Saved to Git for ${unique}`, exact: true });
  await expect(status).toBeVisible();
  await expect(row.getByTestId(`model-cluster-names-${unique}`)).toContainText(CLUSTER);
  await status.click();
  const statusDialog = page.getByRole('dialog', { name: `${unique} status`, exact: true });
  await expect(statusDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(statusDialog).toBeHidden();

  // The model's page, at /models/<id>.
  await row.getByRole('link', { name: unique, exact: true }).click();
  await expect(page).toHaveURL(`/models/${unique}`);
  await expect(page.getByRole('heading', { level: 1, name: unique, exact: true })).toBeVisible();
  await expect(page.getByTestId('model-clusters')).toContainText(CLUSTER);
  await expect(page.getByLabel('Deployment', { exact: true })).toContainText(/Accelerators\s*None \(CPU only\)/);

  // Edit in the deploy wizard: the name users send is read-only, every step opens directly, and Save
  // sends Models/Update with the changed path and the version the page loaded.
  await page.getByRole('button', { name: `Actions for ${unique}` }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Edit model' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^Model URI/ })).toHaveValue(`hf://e2e/${unique}`);
  await expect(page.getByRole('textbox', { name: 'Model name in requests' })).toHaveAttribute('readonly', '');
  await page.getByRole('button', { name: 'Deployment', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Replicas' }).fill('2');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(writeConfirmed(page, `Changes to model ${unique} saved to Git`)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: unique, exact: true })).toBeVisible();
  await expect(page.getByLabel('Deployment', { exact: true })).toContainText(/Replicas\s*2/);

  // While the model is placed on the cluster, the backend refuses to remove the cluster from AI grid
  // (docs/connect.md, "The backend's role rules"): the dialog says so in its words and keeps the
  // typed name.
  await page.goto('/clusters');
  await page.getByRole('button', { name: `Actions for ${CLUSTER}` }).click();
  await page.getByRole('menuitem', { name: 'Remove from AI grid' }).click();
  const remove = page.getByRole('dialog', { name: `Remove ${CLUSTER} from AI grid?` });
  const typed = remove.getByRole('textbox', { name: `Type ${CLUSTER} to confirm:` });
  await typed.fill(CLUSTER);
  await remove.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(
    remove.getByRole('heading', { name: 'Danger alert: Unable to remove cluster from AI grid' }),
  ).toBeVisible();
  // The backend's own message, which still writes "AI Grid".
  await expect(remove).toContainText(
    `Cluster "${CLUSTER}" has 1 model placed on it (${unique}). Move it to another cluster before removing it from AI Grid.`,
  );
  await expect(typed).toHaveValue(CLUSTER);
  await remove.getByRole('button', { name: 'Cancel' }).click();
  await expect(remove).toHaveCount(0);

  // Delete from its Actions menu, on the model's page.
  await page.goto(`/models/${unique}`);
  await expect(page.getByRole('heading', { level: 1, name: unique, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Actions for ${unique}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByLabel(/^Type .* to confirm/).fill(unique);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(writeConfirmed(page, `Model ${unique} deleted from Git`)).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: unique })).toHaveCount(0);
});

test("deploys a model on NVIDIA GPUs with the cluster's default image", async ({ page }) => {
  const unique = `e2e-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto('/models');
  await page.getByRole('link', { name: 'Deploy model' }).click();
  await page.getByRole('textbox', { name: /^Model URI/ }).fill(`hf://e2e/${unique}`);
  await page.getByRole('button', { name: 'Next' }).click();

  // NVIDIA GPU sends no image and no presets: KServe's default preset sets the cluster's vLLM image
  // for NVIDIA GPUs, and the backend at the pin accepts the model without either.
  await expect(page.getByRole('radio', { name: 'NVIDIA GPU' })).toBeChecked();
  const image = page.getByRole('textbox', { name: /^Runtime image/ });
  await expect(image).toHaveValue('');
  await expect(image).not.toHaveAttribute('required');
  await expect(page.getByText("Leave empty to use the cluster's default vLLM image for NVIDIA GPUs.")).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'GPUs' })).toHaveValue('1');
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByRole('combobox', { name: 'Clusters' }).click();
  await page.getByRole('option', { name: CLUSTER }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Next' }).click();

  const review = page.getByTestId('model-review');
  await expect(review).toContainText('HardwareNVIDIA GPU');
  await expect(review).toContainText("Runtime imageDefault (the cluster's vLLM image for NVIDIA GPUs)");
  await expect(review).toContainText(/GPUs\s*1/);
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  await expect(writeConfirmed(page, `Model ${unique} saved to Git`)).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: unique });
  await expect(row.getByRole('button', { name: `Saved to Git for ${unique}`, exact: true })).toBeVisible();

  // The model's page shows what the backend stored: one NVIDIA GPU, and no image of its own.
  await row.getByRole('link', { name: unique, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: unique, exact: true })).toBeVisible();
  const deployment = page.getByLabel('Deployment', { exact: true });
  await expect(deployment).toContainText(/Accelerators\s*1 GPU \(nvidia\.com\/gpu\)/);
  await expect(deployment).toContainText(/Runtime image\s*Default \(the cluster's vLLM image for NVIDIA GPUs\)/);

  await page.getByRole('button', { name: `Actions for ${unique}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByLabel(/^Type .* to confirm/).fill(unique);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(writeConfirmed(page, `Model ${unique} deleted from Git`)).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: unique })).toHaveCount(0);
});

// The bug a slow Git commit caused: the BFF cut Models/Create at its timeout and the wizard said the
// deploy failed, while the commit landed. Here the create reaches the backend and lands; the browser
// gets the BFF's 504 instead of its answer, as when the relay times out. The console must not call
// it a failure: it reads the model back and confirms it.
test('confirms a deploy whose answer was lost instead of calling it failed', async ({ page, request }) => {
  const unique = `e2e-${Math.random().toString(36).slice(2, 8)}`;
  // The create is held until the form has handed it over, then reaches the backend and lands, and the
  // browser gets the BFF's 504 instead of the answer: as when the relay's write timeout cuts a slow
  // commit, which is always after the form's short wait. An answer within the wait stays with the form.
  let handOver = () => undefined as void;
  const handedOver = new Promise<void>((resolve) => {
    handOver = resolve;
  });
  await page.route('**/ai_grid.v1.Models/Create', async (route) => {
    await handedOver;
    await route.fetch();
    await route.fulfill({
      status: 504,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'deadline_exceeded',
        message: 'The AI grid backend did not respond in time. Try again.',
      }),
    });
  });
  try {
    await page.goto('/models/deploy');
    await page.getByRole('textbox', { name: /^Model URI/ }).fill(`hf://e2e/${unique}`);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('radio', { name: 'CPU only' }).check();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('combobox', { name: 'Clusters' }).click();
    await page.getByRole('option', { name: CLUSTER }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Deploy', exact: true }).click();

    // The form leaves after its wait, saying the model is being saved; then the answer is lost.
    await expect(page.getByRole('heading', { name: `Info alert: Saving model ${unique}` })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
    handOver();
    // The read-back confirms the deploy, replacing the in-progress entry.
    await expect(writeConfirmed(page, `Model ${unique} saved to Git`)).toBeVisible();
    await expect(page.getByText(/Unable to deploy/)).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: unique })).toBeVisible();
    // One entry for the write: the confirmation replaced the in-progress entry, and is unread.
    await page.getByRole('button', { name: 'Notifications, 1 unread' }).click();
    const drawer = page.getByRole('list', { name: 'Notifications' });
    await expect(drawer.getByRole('listitem')).toHaveCount(1);
  } finally {
    await tryBackend(request, 'Models/Delete', { id: unique });
  }
});

test("edits a deployed model's URI, CPU and memory, and shows them on its page", async ({ page }) => {
  const unique = `e2e-${Math.random().toString(36).slice(2, 8)}`;
  // On hf://facebook/opt-125m with CPU 100m and memory 1Gi (createModel).
  await createModel(page.request, unique, unique);
  try {
    await page.goto(`/models/${unique}/edit`);
    await expect(page.getByRole('heading', { level: 1, name: 'Edit model' })).toBeVisible();

    // Source: the URI is editable; the name users send is the model's id, fixed.
    const uri = page.getByRole('textbox', { name: /^Model URI/ });
    await expect(uri).toHaveValue('hf://facebook/opt-125m');
    await expect(page.getByRole('textbox', { name: 'Model name in requests' })).toHaveAttribute('readonly', '');
    await uri.fill('hf://facebook/opt-350m');

    // Deployment: CPU and memory, as the Deploy wizard takes them.
    await page.getByRole('button', { name: 'Deployment', exact: true }).click();
    await expect(page.getByRole('textbox', { name: /^CPU/ })).toHaveValue('100m');
    await page.getByRole('textbox', { name: /^CPU/ }).fill('500m');
    await page.getByRole('textbox', { name: /^Memory/ }).fill('2Gi');

    // Review: a new URI changes the model users get under the same name.
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    const review = page.getByTestId('model-review');
    await expect(review).toContainText(/Model URI\s*hf:\/\/facebook\/opt-350m/);
    await expect(review).toContainText(/CPU\s*500m/);
    await expect(review).toContainText(/Memory\s*2Gi/);
    await expect(page.getByTestId('model-uri-changed')).toContainText('This changes the model users are served');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(writeConfirmed(page, `Changes to model ${unique} saved to Git`)).toBeVisible();

    // The model's page reads it back from the backend.
    await expect(page).toHaveURL(`/models/${unique}`);
    const deployment = page.getByLabel('Deployment', { exact: true });
    await expect(deployment).toContainText(/Model URI\s*hf:\/\/facebook\/opt-350m/);
    await expect(deployment).toContainText(/CPU\s*500m/);
    await expect(deployment).toContainText(/Memory\s*2Gi/);
  } finally {
    // Whatever step failed, the catalog is left as it was (zero skips the version check).
    await tryBackend(page.request, 'Models/Delete', { id: unique });
  }
});

test('says when a model page has no model', async ({ page }) => {
  await page.goto('/models/no-such-model');
  await expect(page.getByText('Model not found')).toBeVisible();
});
