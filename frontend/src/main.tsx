import '@patternfly/react-core/dist/styles/base.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { HttpConsoleService } from './api/HttpConsoleService';

const container = document.getElementById('root');
if (!container) {
  throw new Error('missing #root element');
}
createRoot(container).render(
  <React.StrictMode>
    <BrowserRouter>
      <App service={new HttpConsoleService()} />
    </BrowserRouter>
  </React.StrictMode>,
);
