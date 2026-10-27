import { Fragment, lazy, Suspense } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom';
import type { ConsoleService } from './api/ConsoleService';
import { NotFoundPage } from './components/NotFoundPage';
import { PageErrorBoundary } from './components/PageErrorBoundary';
import { PageLoading } from './components/PageLoading';
import { MaaSGovernanceProvider } from './context/MaaSGovernanceContext';
// The landing page (/ goes to /clusters) is in the first download; every other page, and the map
// with Leaflet, loads when it is first opened.
import { ClustersPage } from './pages/clusters/ClustersPage';

const GridPage = lazy(() => import('./pages/grid/GridPage').then((m) => ({ default: m.GridPage })));
const MonitoringPage = lazy(() =>
  import('./pages/monitoring/MonitoringPage').then((m) => ({ default: m.MonitoringPage })),
);
const ModelDetailsPage = lazy(() =>
  import('./pages/models/ModelDetailsPage').then((m) => ({ default: m.ModelDetailsPage })),
);
const ModelEditPage = lazy(() => import('./pages/models/ModelEditPage').then((m) => ({ default: m.ModelEditPage })));
const ModelWizard = lazy(() => import('./pages/models/ModelWizard').then((m) => ({ default: m.ModelWizard })));
const ModelsPage = lazy(() => import('./pages/models/ModelsPage').then((m) => ({ default: m.ModelsPage })));
const OrganizationDetailsPage = lazy(() =>
  import('./pages/organizations/OrganizationDetailsPage').then((m) => ({ default: m.OrganizationDetailsPage })),
);
const OrganizationListPage = lazy(() =>
  import('./pages/organizations/OrganizationListPage').then((m) => ({ default: m.OrganizationListPage })),
);
const OrganizationWizardPage = lazy(() =>
  import('./pages/organizations/OrganizationWizardPage').then((m) => ({ default: m.OrganizationWizardPage })),
);
const CreateSubscriptionPage = lazy(() =>
  import('./pages/subscriptions/CreateSubscriptionPage').then((m) => ({ default: m.CreateSubscriptionPage })),
);
const EditSubscriptionPage = lazy(() =>
  import('./pages/subscriptions/EditSubscriptionPage').then((m) => ({ default: m.EditSubscriptionPage })),
);
const SubscriptionsPage = lazy(() =>
  import('./pages/subscriptions/SubscriptionsPage').then((m) => ({ default: m.SubscriptionsPage })),
);
const ViewSubscriptionPage = lazy(() =>
  import('./pages/subscriptions/ViewSubscriptionPage').then((m) => ({ default: m.ViewSubscriptionPage })),
);

type Props = { service: ConsoleService };

/** Mounts its page afresh for each record, so another :id loads that record and resets its form. */
const ByParams: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Fragment key={Object.values(useParams()).join('/')}>{children}</Fragment>
);

// Ported from krisv/ai-grid-cloud-provider-poc src/app/App.tsx at 62319b8.
export const AppRoutes: React.FC<Props> = ({ service }) => (
  <PageErrorBoundary resetKey={useLocation().pathname}>
    <Suspense fallback={<PageLoading label="Loading page" />}>
      <Pages service={service} />
    </Suspense>
  </PageErrorBoundary>
);

const Pages: React.FC<Props> = ({ service }) => (
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
