// Small shared pieces: status labels, short lists and chart ticks.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { MockConsoleService } from '../api/MockConsoleService';
import { OverflowList } from '../components/OverflowList';
import { PageErrorBoundary } from '../components/PageErrorBoundary';
import { PageLoading } from '../components/PageLoading';
import { StatusLabel } from '../components/StatusLabel';
import { tickLabel } from '../pages/grid/chartScale';
import { getSubtextProps } from '../utilities/phaseLabelUtils';
import { statusLabelProps } from '../utilities/status';

it("opens a status's reason from the keyboard", async () => {
  const user = userEvent.setup();
  render(<StatusLabel status="Unknown" reason="The hub hasn't heard from the cluster." />);
  await user.tab();
  expect(await screen.findByRole('tooltip')).toHaveTextContent("The hub hasn't heard from the cluster.");
});

it('leaves a status without a reason out of the tab order', () => {
  render(<StatusLabel status="Ready" />);
  expect(screen.getByText('Ready').closest('[tabindex]')).toBeNull();
});

it('says what "+N more" holds, and keys same-named items apart', async () => {
  const user = userEvent.setup();
  render(<OverflowList items={['Paris DC1', 'Paris DC1']} noun="Locations" />);
  const more = screen.getByRole('button', { name: '+1 more locations' });
  await user.click(more);
  expect(within(await screen.findByRole('dialog')).getAllByRole('listitem')).toHaveLength(2);
});

it('spaces the first item from its "+N more" label', () => {
  const { container } = render(<OverflowList items={['Paris DC1', 'Madrid DC1']} noun="Locations" />);
  const row = container.firstElementChild!;
  expect(row).toHaveClass('pf-v6-l-flex', 'pf-m-space-items-sm');
  // Flex spacing applies to elements, so the first item is one rather than a bare text node.
  expect(row.firstChild?.nodeType).toBe(Node.ELEMENT_NODE);
  expect(row.firstChild).toHaveTextContent('Paris DC1');
});

it("centres a page's loading spinner in a filled section", () => {
  render(<PageLoading label="Loading clusters" />);
  const bullseye = screen.getByRole('progressbar', { name: 'Loading clusters' }).parentElement!;
  // A Bullseye that grows to the section's height: the section is a flex column without the body
  // wrapper, so the spinner sits in the page's middle rather than its top left corner.
  expect(bullseye).toHaveClass('pf-v6-l-bullseye', 'pf-v6-u-flex-grow-1');
  expect(bullseye.parentElement).toHaveClass('pf-v6-c-page__main-section', 'pf-m-fill');
});

it('shows billions as B on chart ticks', () => {
  expect(tickLabel(1_500_000_000)).toBe('1.5B');
  expect(tickLabel(6_000_000_000)).toBe('6B');
  expect(tickLabel(2_419_400_000)).toBe('2.4B');
  expect(tickLabel(150_000_000)).toBe('150M');
});

it('gives a phase the same colour in its label and its subtext', () => {
  expect(statusLabelProps('Unavailable').status).toBe('danger');
  expect(getSubtextProps('Unavailable')).toEqual({ className: 'pf-v6-u-text-color-status-danger' });
  expect(getSubtextProps('Degraded')).toEqual({ className: 'pf-v6-u-text-color-status-warning' });
  expect(getSubtextProps('Ready')).toBeUndefined();
});

it('offers Log out while the console configuration is still loading', async () => {
  const service = new MockConsoleService();
  service.getConfig = () => new Promise(() => undefined);
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <App service={service} />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('button', { name: /dev-user/ }));
  expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeVisible();
});

it('offers a reload when a page fails to load, and tries again on another page', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  try {
    // What React.lazy throws when a page's chunk is gone after a redeploy.
    const Missing = () => {
      throw new TypeError('Failed to fetch dynamically imported module: /assets/ModelsPage-abc123.js');
    };
    const user = userEvent.setup();
    const { rerender } = render(
      <PageErrorBoundary resetKey="/models">
        <Missing />
      </PageErrorBoundary>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'This page could not be loaded' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalled();
    rerender(
      <PageErrorBoundary resetKey="/clusters">
        <p>Clusters</p>
      </PageErrorBoundary>,
    );
    expect(screen.getByText('Clusters')).toBeVisible();
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
