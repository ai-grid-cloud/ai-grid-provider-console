import '@patternfly/react-core/dist/styles/base.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { TransportProvider } from '@connectrpc/connect-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { HttpConsoleService } from './api/HttpConsoleService';
import { createQueryClient, createTransport } from './api/transport';

const container = document.getElementById('root');
if (!container) {
  throw new Error('missing #root element');
}

// Both data layers are mounted during the migration: pages still use HttpConsoleService, and
// move to generated Connect hooks one at a time (issue #22). The providers are inert for a
// page that does not use them.
const transport = createTransport();
const queryClient = createQueryClient();

createRoot(container).render(
  <React.StrictMode>
    <TransportProvider transport={transport}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App service={new HttpConsoleService()} />
        </BrowserRouter>
      </QueryClientProvider>
    </TransportProvider>
  </React.StrictMode>,
);
