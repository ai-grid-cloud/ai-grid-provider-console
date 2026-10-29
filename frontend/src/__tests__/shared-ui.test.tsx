// Small shared pieces: page states, status labels, short lists and chart ticks.
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import { TestApp } from './TestApp';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ServiceError } from '../api/ConsoleService';
import { MockConsoleService } from '../api/MockConsoleService';
import { renderAt, findVisible } from './render';
import { modelsOf } from './connectModels';
import { ModelPhase } from '../gen/ai_grid/v1/model_type_pb';
import '../pages/models/ModelsPage';
import '../pages/subscriptions/SubscriptionsPage';
import { seedSubscriptionsOf } from './connectSubscriptions';
import { LoadError } from '../components/LoadError';
import { OverflowList } from '../components/OverflowList';
import { PageErrorBoundary } from '../components/PageErrorBoundary';
import { PageLoading } from '../components/PageLoading';
import { StatusLabel } from '../components/StatusLabel';
import { EmptyListState } from '../components/states/EmptyListState';
import { ErrorState } from '../components/states/ErrorState';
import { PageStateSection } from '../components/states/PageStateSection';
import { SectionEmptyState } from '../components/states/SectionEmptyState';
import { tickLabel } from '../pages/grid/chartScale';
import { getSubtextProps } from '../utilities/phaseLabelUtils';
import { statusLabelProps } from '../utilities/status';

it("opens a status's reason from the keyboard", async () => {
  const user = userEvent.setup();
  render(<StatusLabel status="Unknown" reason="The hub hasn't heard from the cluster." />);
  await user.tab();
  expect(await screen.findByRole('tooltip')).toHaveTextContent("The hub hasn't heard from the cluster.");
});

it('fills a status label only when it opens something', async () => {
  const onClick = vi.fn();
  const user = userEvent.setup();
  render(
    <>
      <StatusLabel status="Ready" data-testid="plain" />
      <StatusLabel status="Failed" onClick={onClick} data-testid="clickable" />
    </>,
  );
  expect(screen.getByTestId('plain')).toHaveClass('pf-m-outline');
  expect(screen.getByTestId('clickable')).not.toHaveClass('pf-m-outline');
  await user.click(screen.getByRole('button', { name: 'Failed' }));
  expect(onClick).toHaveBeenCalledTimes(1);
});

it('gives every status label in one column one variant, whatever the status: /subscriptions', async () => {
  const service = new MockConsoleService();
  seedSubscriptionsOf(service);
  renderAt('/subscriptions', service);
  const rows = await screen.findByTestId('subscriptions-table');
  const labels = Array.from(rows.querySelectorAll<HTMLElement>('td[data-label="Status"] .pf-v6-c-label'));
  expect(new Set(labels.map((l) => l.textContent)).size).toBeGreaterThan(2);
  // One variant per column: status labels open nothing, so every one is an outline label, no button.
  expect(new Set(labels.map((l) => l.classList.contains('pf-m-outline')))).toEqual(new Set([true]));
  for (const label of labels) {
    expect(within(label).queryByRole('button')).not.toBeInTheDocument();
  }
});

it("gives the Models list's status column one variant, whatever the phase: outline, opening nothing", async () => {
  const service = new MockConsoleService();
  const models = modelsOf(service);
  const phases = [ModelPhase.READY, ModelPhase.FAILED, ModelPhase.PARTIALLY_AVAILABLE];
  models.models.forEach((m, i) => (m.status!.phase = phases[i % phases.length]));
  renderAt('/models', service);
  const rows = await screen.findByTestId('model-deployments-table');
  const labels = Array.from(rows.querySelectorAll<HTMLElement>('td[data-label="Status"] .pf-v6-c-label'));
  expect(new Set(labels.map((l) => l.textContent)).size).toBeGreaterThan(2);
  expect(new Set(labels.map((l) => l.classList.contains('pf-m-outline')))).toEqual(new Set([true]));
  for (const label of labels) {
    expect(within(label).queryByRole('button')).not.toBeInTheDocument();
  }
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
  expect(statusLabelProps('Failed').status).toBe('danger');
  expect(getSubtextProps('Failed')).toEqual({ className: 'pf-v6-u-text-color-status-danger' });
  expect(getSubtextProps('Partially available')).toEqual({ className: 'pf-v6-u-text-color-status-warning' });
  expect(getSubtextProps('Ready')).toBeUndefined();
});

it('offers Log out while the console configuration is still loading', async () => {
  const service = new MockConsoleService();
  service.getConfig = () => new Promise(() => undefined);
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <TestApp service={service} />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('button', { name: /dev-user/ }));
  await findVisible('menuitem', 'Log out');
});

it('offers a reload when a page fails to load, and tries again on another page', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
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
  expect(screen.getByRole('heading', { level: 1, name: 'Unable to load this page' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Reload' }));
  expect(reload).toHaveBeenCalled();
  rerender(
    <PageErrorBoundary resetKey="/clusters">
      <p>Clusters</p>
    </PageErrorBoundary>,
  );
  expect(screen.getByText('Clusters')).toBeVisible();
});

describe('page states', () => {
  const notFound = { what: 'Widget', name: 'w1', listPath: '/widgets', listLabel: 'Widgets' };
  const renderLoadError = (error: Error, onRetry = vi.fn()) =>
    render(
      <MemoryRouter>
        <LoadError subject="Widgets" object="widget" error={error} onRetry={onRetry} notFound={notFound} />
      </MemoryRouter>,
    );

  it('shows a failed load as an error state with Retry', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    renderLoadError(new ServiceError(503, 'Service unavailable.'), onRetry);
    const state = screen.getByTestId('error-state');
    expect(state).toHaveClass('pf-m-danger');
    expect(within(state).getByRole('heading', { level: 2, name: 'Unable to load widget' })).toBeVisible();
    expect(state).toHaveTextContent('Service unavailable.');
    await user.click(within(state).getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('says an object is not found, with its list and no Retry', () => {
    renderLoadError(new ServiceError(404, 'object with identifier w1 not found'));
    const state = screen.getByTestId('not-found-state');
    expect(within(state).getByRole('heading', { name: 'Widget not found' })).toBeVisible();
    expect(state).toHaveTextContent("There's no widget named w1. It may have been deleted, or the link may be wrong.");
    expect(within(state).getByText('w1').tagName).toBe('CODE');
    expect(within(state).getByRole('link', { name: 'Go to Widgets' })).toHaveAttribute('href', '/widgets');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByText(/object with identifier/)).not.toBeInTheDocument();
  });

  it('says a 501 is not available yet, without Retry', () => {
    renderLoadError(new ServiceError(501, 'not implemented'));
    expect(screen.getByRole('heading', { name: 'Widgets are not available on this backend yet' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('says a 403 is no access, with the reason', () => {
    renderLoadError(new ServiceError(403, 'widgets are for admins'));
    expect(screen.getByRole('heading', { level: 2, name: "You don't have access to widget" })).toBeVisible();
    expect(screen.getByText('widgets are for admins')).toBeVisible();
  });

  it('shows nothing for an ended session', () => {
    const { container } = renderLoadError(new ServiceError(401, 'expired'));
    expect(container).toBeEmptyDOMElement();
  });

  it('gives an empty list its create action, and a section a small state', () => {
    render(
      <>
        <EmptyListState title="No widgets" action={<button>Create widget</button>}>
          Create a widget to start.
        </EmptyListState>
        <SectionEmptyState title="No parts">This widget has no parts.</SectionEmptyState>
      </>,
    );
    expect(screen.getByTestId('empty-list-state')).toHaveClass('pf-m-lg');
    expect(screen.getByRole('heading', { level: 2, name: 'No widgets' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create widget' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 3, name: 'No parts' }).closest('.pf-v6-c-empty-state')).toHaveClass(
      'pf-m-xs',
    );
  });

  it('labels its action as asked', () => {
    render(<ErrorState title="Unable to load this page" retryLabel="Reload" onRetry={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeVisible();
  });

  /** A page whose load the test controls, with an input that must survive a failed reload. */
  const Page: React.FC<{ loaded: boolean; error?: Error; onRetry?: () => void; list?: boolean }> = ({
    loaded,
    error,
    onRetry,
    list = false,
  }) => {
    const [text, setText] = useState('');
    return (
      <MemoryRouter>
        <PageStateSection
          title="w1"
          headerAction={<button>Actions</button>}
          loaded={loaded}
          error={error}
          onRetry={onRetry ?? (() => undefined)}
          subject="Widgets"
          object="widget"
          loadingLabel="Loading widget"
          notFound={list ? undefined : notFound}
        >
          <input aria-label="Name" value={text} onChange={(e) => setText(e.target.value)} />
        </PageStateSection>
      </MemoryRouter>
    );
  };

  it("shows nothing from an object's URL id until the object answers", () => {
    const { rerender } = render(<Page loaded={false} />);
    expect(screen.getByRole('progressbar', { name: 'Loading widget' })).toBeVisible();
    // No title or breadcrumb from the id: the real header comes with the object.
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    rerender(<Page loaded error={new ServiceError(503, 'Service unavailable.')} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Widgets' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Unable to load widget' })).toBeVisible();
    rerender(<Page loaded />);
    expect(screen.getByRole('heading', { level: 1, name: 'w1' })).toBeVisible();
  });

  it("keeps a list page's header while it loads, and replaces the content when the first load fails", () => {
    const { rerender } = render(<Page list loaded={false} />);
    expect(screen.getByRole('heading', { level: 1, name: 'w1' })).toBeVisible();
    expect(screen.getByRole('progressbar', { name: 'Loading widget' })).toBeVisible();
    rerender(<Page list loaded error={new ServiceError(503, 'Service unavailable.')} />);
    expect(screen.getByRole('heading', { name: 'Unable to load widget' })).toBeVisible();
    // Actions need the object, so they go with it.
    expect(screen.queryByRole('button', { name: 'Actions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
  });

  it('keeps what it showed, and the user input, under a warning when a reload fails', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Page loaded onRetry={onRetry} />);
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'kept');
    rerender(<Page loaded error={new ServiceError(503, 'Service unavailable.')} onRetry={onRetry} />);
    const alert = screen.getByTestId('stale-data-alert');
    expect(alert).toHaveTextContent('Showing the last loaded widget');
    expect(alert).toHaveTextContent('Service unavailable.');
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('kept');
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<Page loaded onRetry={onRetry} />);
    expect(screen.queryByTestId('stale-data-alert')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('kept');
  });

  it("says an object that is gone is not found, under its list's name", () => {
    const { rerender } = render(<Page loaded />);
    rerender(<Page loaded error={new ServiceError(404, 'gone')} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Widgets' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Widget not found' })).toBeVisible();
    expect(screen.queryByTestId('stale-data-alert')).not.toBeInTheDocument();
  });
});
