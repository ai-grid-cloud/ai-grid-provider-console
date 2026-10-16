import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { MockConsoleService } from '../api/MockConsoleService';
import { ServiceError } from '../api/ConsoleService';

describe('App', () => {
  it('shows the signed-in user and the clusters from the service', async () => {
    const service = new MockConsoleService();
    render(<App service={service} />);

    await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('dev-user (provider admin)'));
    expect(await screen.findByText('local-cluster')).toBeInTheDocument();
    expect(screen.getByText('Paris DC1')).toBeInTheDocument();
    expect(screen.getAllByText('Member')).toHaveLength(3);
  });

  it('does not call a viewer a provider admin', async () => {
    const service = new MockConsoleService({ username: 'viewer', groups: [], isProviderAdmin: false });
    render(<App service={service} />);

    await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('viewer'));
    expect(screen.getByTestId('masthead-user')).not.toHaveTextContent('provider admin');
  });

  it('navigates to tenants and shows them', async () => {
    render(<App service={new MockConsoleService()} />);
    fireEvent.click(await screen.findByRole('link', { name: 'Tenants' }));

    expect(await screen.findByTestId('tenant-acme-robotics')).toBeInTheDocument();
    expect(screen.getByText('globex.example.com')).toBeInTheDocument();
  });

  it('shows a not-available state, not an error, when the backend lacks the RPC', async () => {
    const service = new MockConsoleService();
    service.listTenants = async () => {
      throw new ServiceError(501, 'the AI Grid backend does not support this operation yet');
    };
    render(<App service={service} />);
    fireEvent.click(await screen.findByRole('link', { name: 'Tenants' }));

    expect(await screen.findByText('Tenants are not available on this backend yet')).toBeInTheDocument();
    expect(screen.queryByText('Tenants could not be loaded')).not.toBeInTheDocument();
  });

  it('shows the backend error when tenants cannot be loaded', async () => {
    const service = new MockConsoleService();
    service.listTenants = async () => {
      throw new ServiceError(502, 'the AI Grid backend failed to process the request');
    };
    render(<App service={service} />);
    fireEvent.click(await screen.findByRole('link', { name: 'Tenants' }));

    expect(await screen.findByText('Tenants could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('the AI Grid backend failed to process the request')).toBeInTheDocument();
  });
});
