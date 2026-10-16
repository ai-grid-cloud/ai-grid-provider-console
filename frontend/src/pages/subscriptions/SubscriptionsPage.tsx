// Ported from krisv/ai-grid-cloud-provider-poc src/app/App.tsx (the /subscriptions route) at 62319b8.
import { Content, PageSection, Title } from '@patternfly/react-core';
import type { GovernanceService } from '../../context/useMaaSGovernanceContext';
import { SubscriptionsTab } from './SubscriptionsTab';

type Props = { service: GovernanceService };

export const SubscriptionsPage: React.FC<Props> = ({ service }) => (
  <>
    <PageSection>
      <Title headingLevel="h2">Subscriptions</Title>
      <Content component="p">Manage subscriptions to models available through Models as a Service.</Content>
    </PageSection>
    <SubscriptionsTab service={service} />
  </>
);
