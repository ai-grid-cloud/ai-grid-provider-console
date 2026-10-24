import { Fragment } from 'react';
import { Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom';
import type { ConsoleService } from './api/ConsoleService';
import { NotFoundPage } from './components/NotFoundPage';
import { MaaSGovernanceProvider } from './context/MaaSGovernanceContext';
import { ClustersPage } from './pages/clusters/ClustersPage';
import { GridPage } from './pages/grid/GridPage';
import { MonitoringPage } from './pages/monitoring/MonitoringPage';
import { ModelDetailsPage } from './pages/models/ModelDetailsPage';
import { ModelEditPage } from './pages/models/ModelEditPage';
import { ModelWizard } from './pages/models/ModelWizard';
import { ModelsPage } from './pages/models/ModelsPage';
import { OrganizationDetailsPage } from './pages/organizations/OrganizationDetailsPage';
import { OrganizationListPage } from './pages/organizations/OrganizationListPage';
import { OrganizationWizardPage } from './pages/organizations/OrganizationWizardPage';
import { CreateSubscriptionPage } from './pages/subscriptions/CreateSubscriptionPage';
import { EditSubscriptionPage } from './pages/subscriptions/EditSubscriptionPage';
import { SubscriptionsPage } from './pages/subscriptions/SubscriptionsPage';
import { ViewSubscriptionPage } from './pages/subscriptions/ViewSubscriptionPage';

type Props = { service: ConsoleService };

/** Mounts its page afresh for each record, so another :id loads that record and resets its form. */
const ByParams: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Fragment key={Object.values(useParams()).join('/')}>{children}</Fragment>
);

// Ported from krisv/ai-grid-cloud-provider-poc src/app/App.tsx at 62319b8.
export const AppRoutes: React.FC<Props> = ({ service }) => (
  <Routes>
    <Route path="/" element={<Navigate to="/clusters" replace />} />
    {/* Keyed, so moving between the map and monitoring mounts a fresh page with its own loads. */}
    <Route path="/ai-grid" element={<GridPage key="ai-grid" service={service} />} />
    <Route path="/monitoring" element={<MonitoringPage service={service} />} />
    <Route path="/clusters" element={<ClustersPage service={service} />} />
    <Route path="/organizations" element={<OrganizationListPage service={service} />} />
    <Route path="/organizations/create" element={<OrganizationWizardPage service={service} />} />
    <Route
      path="/organizations/:id"
      element={
        <ByParams>
          <OrganizationDetailsPage service={service} />
        </ByParams>
      }
    />
    <Route
      path="/organizations/:id/edit"
      element={
        <ByParams>
          <OrganizationWizardPage service={service} />
        </ByParams>
      }
    />
    <Route path="/models" element={<ModelsPage service={service} />} />
    <Route path="/models/deploy" element={<ModelWizard service={service} />} />
    <Route
      path="/models/:namespace/:name"
      element={
        <ByParams>
          <ModelDetailsPage service={service} />
        </ByParams>
      }
    />
    <Route
      path="/models/:namespace/:name/edit"
      element={
        <ByParams>
          <ModelEditPage service={service} />
        </ByParams>
      }
    />
    {/* The subscription pages share the PoC's governance context, and only they use it (A25). */}
    <Route
      element={
        <MaaSGovernanceProvider service={service}>
          <Outlet />
        </MaaSGovernanceProvider>
      }
    >
      <Route path="/subscriptions" element={<SubscriptionsPage service={service} />} />
      <Route path="/subscriptions/create" element={<CreateSubscriptionPage service={service} />} />
      <Route
        path="/subscriptions/view/:subscriptionName"
        element={
          <ByParams>
            <ViewSubscriptionPage service={service} />
          </ByParams>
        }
      />
      <Route
        path="/subscriptions/edit/:subscriptionName"
        element={
          <ByParams>
            <EditSubscriptionPage service={service} />
          </ByParams>
        }
      />
    </Route>
    <Route path="*" element={<NotFoundPage />} />
  </Routes>
);
