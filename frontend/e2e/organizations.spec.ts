import type { APIRequestContext } from '@playwright/test';
import { callBackend, tryBackend } from './backend';
import { expect, test } from './fixtures';

// The Organizations pages call the backend's Tenants API over Connect, so this spec runs on the
// backend's own fakes (playwright.config.ts, "backend fakes"): its fake Keycloak holds the PoC's
// organizations (fixtures/poc/organizations.json). Before it writes an identity provider, the
// backend has Keycloak read the issuer's discovery document, as Keycloak does at login; the
// issuer here answers nothing, so the backend refuses to create one.

type Tenant = { id: string; metadata?: { name?: string; version?: number } };

/** Deletes the organization named `name` if a failed step left it behind. */
const removeOrganization = async (request: APIRequestContext, name: string) => {
  const { items = [] } = await callBackend<{ items?: Tenant[] }>(request, 'Tenants/List', {});
  const left = items.find((t) => t.metadata?.name === name);
  if (left) await tryBackend(request, 'Tenants/Delete', { id: left.id, version: left.metadata?.version ?? 1 });
};

test('creates, views, edits and deletes an organization', async ({ page }) => {
  const unique = `e2e-${Math.random().toString(36).slice(2, 8)}`;
  const domain = `${unique}.example.com`;
  const editedDomain = `edited-${unique}.example.com`;
  const issuer = `https://idp.${domain}/realms/main`;
  try {
    await page.goto('/organizations');
    await page.getByRole('link', { name: 'Create organization' }).click();

    // Step 1: details
    await page.getByRole('textbox', { name: /^Name/ }).fill(unique);
    // The form starts with a field for the domain an organization needs.
    await page.getByRole('textbox', { name: /^Domain 1/ }).fill(domain);
    await page.getByRole('button', { name: 'Next' }).click();

    // Step 2: identity provider
    const idpFields: [RegExp, string][] = [
      [/^Client ID/, 'console'],
      [/^Client secret reference/, 'idp-secret'],
      [/^Issuer/, issuer],
      [/^Authorization URL/, `${issuer}/auth`],
      [/^Token URL/, `${issuer}/token`],
      // Required while Validate signature is on, as it is by default.
      [/^JSON Web Key Set \(JWKS\) URL/, `${issuer}/certs`],
    ];
    for (const [name, value] of idpFields) await page.getByRole('textbox', { name }).fill(value);
    await page.getByRole('button', { name: 'Next' }).click();

    // Step 3: review. Keycloak can't read the issuer's discovery document, so the backend refuses
    // in words that name it, and the form stays.
    await expect(page.getByText(issuer).first()).toBeVisible();
    await page.getByRole('button', { name: 'Create organization' }).click();
    await expect(page.getByText('Unable to save organization')).toBeVisible();
    await expect(
      page.getByText(`Keycloak could not read the OIDC discovery document ${issuer}/.well-known/openid-configuration`),
    ).toBeVisible();

    // Without an identity provider it saves.
    await page.getByRole('button', { name: 'Identity provider', exact: true }).click();
    for (const [name] of idpFields) await page.getByRole('textbox', { name }).fill('');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('heading', { name: 'No identity provider configured in AI grid' })).toBeVisible();
    await page.getByRole('button', { name: 'Create organization' }).click();
    await expect(page.getByText(`Organization ${unique} created`)).toBeVisible();

    const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: unique, exact: true }) });
    await expect(row).toContainText(domain);

    // View
    await row.getByRole('link', { name: unique, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: unique, exact: true })).toBeVisible();
    await expect(page.getByText(domain).first()).toBeVisible();

    // Edit a domain in the create wizard, whose steps are all open when editing; the deep link and
    // reload land on the same page.
    await page.getByRole('button', { name: `Actions for ${unique}` }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    await expect(page).toHaveURL(/\/organizations\/[^/]+\/edit$/);
    await page.reload();
    await page.getByRole('textbox', { name: /^Domain 1/ }).fill(editedDomain);
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(`Changes to organization ${unique} saved`)).toBeVisible();
    await expect(page.getByTestId('organization-configuration-details')).toContainText(editedDomain);

    // Delete from the organization's page, with the typed confirmation
    await page.getByRole('button', { name: `Actions for ${unique}` }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const confirm = page.getByRole('button', { name: 'Delete', exact: true });
    await expect(confirm).toBeDisabled();
    await page.getByLabel(/^Type .* to confirm/).fill(unique);
    await confirm.click();
    await expect(page.getByText(`Organization ${unique} deleted`)).toBeVisible();
    await expect(page.getByRole('link', { name: unique, exact: true })).toHaveCount(0);

    // Each write is in the drawer, newest first, as read: they answered the user's own clicks. The
    // refused create stayed on the form and isn't there.
    await page.getByRole('button', { name: 'Notifications', exact: true }).click();
    const drawer = page.getByRole('list', { name: 'Notifications' });
    await expect(drawer.getByRole('listitem')).toHaveCount(3);
    await expect(drawer.getByRole('listitem').nth(0)).toContainText(`Organization ${unique} deleted`);
    await expect(drawer.getByRole('listitem').nth(1)).toContainText(`Changes to organization ${unique} saved`);
    await expect(drawer.getByRole('listitem').nth(2)).toContainText(`Organization ${unique} created`);
  } finally {
    await removeOrganization(page.request, unique);
  }
});

// PatternFly's utility classes (pf-v6-u-*) only work when main.tsx loads patternfly-addons.css.
// A probe element keeps the check independent of which page happens to use one.
test('applies PatternFly utility classes', async ({ page }) => {
  await page.goto('/organizations');
  await expect(page.getByRole('heading', { name: 'Organizations' })).toBeVisible();
  const marginTop = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'pf-v6-u-my-md';
    document.body.append(probe);
    const value = getComputedStyle(probe).marginTop;
    probe.remove();
    return value;
  });
  expect(marginTop).toBe('16px');
});
