import { PageSection } from '@patternfly/react-core';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { ConsoleService } from './api/ConsoleService';
import { NotFoundPage } from './components/NotFoundPage';
import { NotYetPortedPage } from './components/NotYetPortedPage';
import { ClustersPage } from './pages/ClustersPage';
import { OrganizationDetailsPage } from './pages/organizations/OrganizationDetailsPage';
import { OrganizationListPage } from './pages/organizations/OrganizationListPage';
import { OrganizationWizardPage } from './pages/organizations/OrganizationWizardPage';

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
          <OrganizationListPage service={service} />
        </PageSection>
      }
    />
    <Route
      path="/organizations/create"
      element={
        <PageSection>
          <OrganizationWizardPage service={service} />
        </PageSection>
      }
    />
    <Route
      path="/organizations/:id"
      element={
        <PageSection>
          <OrganizationDetailsPage service={service} />
        </PageSection>
      }
    />
    <Route
      path="/organizations/:id/edit"
      element={
        <PageSection>
          <OrganizationWizardPage service={service} />
        </PageSection>
      }
    />
    <Route path="/models" element={<NotYetPortedPage title="Models" />} />
    <Route path="/models/deploy" element={<NotYetPortedPage title="Deploy model" />} />
    <Route path="/subscriptions" element={<NotYetPortedPage title="Subscriptions" />} />
    <Route path="/subscriptions/create" element={<NotYetPortedPage title="Create subscription" />} />
    <Route path="/subscriptions/view/:name" element={<NotYetPortedPage title="Subscription" />} />
    <Route path="/subscriptions/edit/:name" element={<NotYetPortedPage title="Edit subscription" />} />
    <Route path="*" element={<NotFoundPage />} />
  </Routes>
);
