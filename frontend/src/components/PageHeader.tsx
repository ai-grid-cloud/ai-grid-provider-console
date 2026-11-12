// Ported from krisv/ai-grid-cloud-provider-poc src/shared/dashboard.tsx (ApplicationsPage) at 62319b8:
// its header section only, so every page's title, breadcrumb and description sit the same way.
import { Content, Flex, FlexItem, PageBreadcrumb, PageSection, Stack, Title } from '@patternfly/react-core';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

type Props = {
  title: string;
  description?: React.ReactNode;
  breadcrumb?: React.ReactElement;
  /** A resource's status label, beside its name. */
  status?: React.ReactNode;
  headerAction?: React.ReactNode;
};

/**
 * A page's header: the breadcrumb in PatternFly's PageBreadcrumb section, then the h1 title with its status beside it and its action at the
 * end, then the description. The title also names the browser tab.
 */
export const PageHeader: React.FC<Props> = ({ title, description, breadcrumb, status, headerAction }) => {
  useDocumentTitle(title);
  return (
    <>
      {/* PatternFly's page breadcrumb section, above the title's section. */}
      {breadcrumb && <PageBreadcrumb>{breadcrumb}</PageBreadcrumb>}
      <PageSection>
        <Stack hasGutter>
          <Flex
            justifyContent={{ default: 'justifyContentSpaceBetween' }}
            alignItems={{ default: 'alignItemsCenter' }}
            spaceItems={{ default: 'spaceItemsMd' }}
          >
            <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsMd' }}>
              <Title headingLevel="h1" size="2xl">
                {title}
              </Title>
              {status}
            </Flex>
            {headerAction && <FlexItem>{headerAction}</FlexItem>}
          </Flex>
          {description && <Content component="p">{description}</Content>}
        </Stack>
      </PageSection>
    </>
  );
};
