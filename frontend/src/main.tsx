import '@patternfly/react-core/dist/styles/base.css';
import '@patternfly/patternfly/patternfly-addons.css';
// The chart palette's colour tokens, for the Monitoring charts.
import '@patternfly/patternfly/patternfly-charts.css';
import './style.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { HttpConsoleService } from './api/HttpConsoleService';

const container = document.getElementById('root');
if (!container) {
  throw new Error('missing #root element');
}
createRoot(container).render(
  <React.StrictMode>
    {/* Outside the router, so a crash anywhere in the console still shows something. */}
    <AppErrorBoundary>
      <BrowserRouter>
        <App service={new HttpConsoleService()} />
      </BrowserRouter>
    </AppErrorBoundary>
  </React.StrictMode>,
);
