import { PageSection } from '@patternfly/react-core';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { ConsoleService } from './api/ConsoleService';
import { NotFoundPage } from './components/NotFoundPage';
import { NotYetPortedPage } from './components/NotYetPortedPage';
import { ClustersPage } from './pages/ClustersPage';
import { TenantsPage } from './pages/TenantsPage';

type Props = { service: ConsoleService };

// Ported from krisv/ai-grid-cloud-provider-poc src/app/App.tsx at 62319b8.
// Later tasks replace each NotYetPortedPage with its page.
export const AppRoutes: React.FC<Props> = ({ service }) => (
  <Routes>
    <Route path="/" element={<Navigate to="/clusters" replace />} />
    <Route path="/ai-grid" element={<NotYetPortedPage title="AI Grid" />} />
    <Route path="/monitoring" element={<NotYetPortedPage title="Monitoring" />} />
    <Route
      path="/clusters"
      element={
        <PageSection>
          <ClustersPage service={service} />
        </PageSection>
      }
    />
    <Route
      path="/organizations"
      element={
        <PageSection>
          <TenantsPage service={service} />
        </PageSection>
      }
    />
    <Route path="/organizations/create" element={<NotYetPortedPage title="Create organization" />} />
    <Route path="/organizations/:id" element={<NotYetPortedPage title="Organization" />} />
    <Route path="/organizations/:id/edit" element={<NotYetPortedPage title="Edit organization" />} />
    <Route path="/models" element={<NotYetPortedPage title="Models" />} />
    <Route path="/models/deploy" element={<NotYetPortedPage title="Deploy model" />} />
    <Route path="/subscriptions" element={<NotYetPortedPage title="Subscriptions" />} />
    <Route path="/subscriptions/create" element={<NotYetPortedPage title="Create subscription" />} />
    <Route path="/subscriptions/view/:name" element={<NotYetPortedPage title="Subscription" />} />
    <Route path="/subscriptions/edit/:name" element={<NotYetPortedPage title="Edit subscription" />} />
    <Route path="*" element={<NotFoundPage />} />
  </Routes>
);
