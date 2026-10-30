import { useRef, useState } from 'react';
import {
  Breadcrumb,
  BreadcrumbItem,
  Button,
  Card,
  CardBody,
  Content,
  Flex,
  Grid,
  GridItem,
  List,
  ListItem,
  Stack,
} from '@patternfly/react-core';
import { SubtleText } from '../../components/SubtleText';
import { ExternalLinkAltIcon } from '@patternfly/react-icons';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { GridMembership } from '../../api/clusters';
import type { ClusterGPUs, GPUNode } from '../../gen/ai_grid/v1/managed_cluster_type_pb';
import { DetailsList } from '../../components/DetailsList';
import { DetailsSection } from '../../components/DetailsSection';
import { TableRowTitleDescription } from '../../components/TableRowTitleDescription';
import { PageStateSection } from '../../components/states/PageStateSection';
import { RelativeTime } from '../../components/RelativeTime';
import { SimpleMenuActions } from '../../components/SimpleMenuActions';
import { StatusLabel } from '../../components/StatusLabel';
import { useConsoleSession } from '../../context/useConsoleSession';
import { EMPTY_VALUE } from '../../utilities/format';
import { formatCores, formatGiB } from '../../utilities/quantity';
import { gpuCount, membershipAction, statusReason } from './clusterInfo';
import {
  capacityText,
  configurationText,
  gpuArchitecture,
  gpuCountText,
  gpuMemory,
  gpuModel,
  gpuSharing,
} from './gpuText';
import type { MembershipChange } from './MembershipModal';
import { MembershipModal } from './MembershipModal';
import { changeMembership } from './changeMembership';
import { MissingLabel } from './MissingLabel';
import { roleOf } from './roles';
import type { ClusterView } from './clusterView';
import { useCluster, useMembershipWrites } from './useClusters';
import { ClusterDataCenter } from './ClusterSite';
import { isFromCloudRegion, LOCATION_DOCS_URL } from './site';

/** "68 cores, 65 allocatable", or only the capacity when the hub reports no allocatable value. */
const withAllocatable = (capacity?: string, allocatable?: string) =>
  capacity && allocatable && capacity !== allocatable ? `${capacity}, ${allocatable} allocatable` : capacity;

const aiGridItems = (c: ClusterView) => {
  const role = roleOf(c.labels);
  return [
    {
      term: 'Status',
      value: <StatusLabel isCompact status={c.aiGridEnabled ? c.provisioningStatus : 'Not added'} />,
      'data-testid': 'cluster-membership',
    },
    {
      term: 'Location label',
      value: c.location,
    },
    {
      term: 'Role',
      value: !c.aiGridEnabled ? undefined : role ? (
        `${role.label}: ${role.description}`
      ) : (
        <MissingLabel
          testId="missing-role"
          reason="This member has no role, so the hub doesn't install OpenShift AI or MaaS on it, and it never finishes provisioning. Remove it from AI Grid and add it again to choose a role."
        >
          No role
        </MissingLabel>
      ),
    },
  ];
};

/**
 * The cluster as the hub sees it, its connection first, as the peer of the AI Grid card's status.
 * ACM sets the OpenShift version only on OpenShift clusters (the version.openshift.io claim), so
 * another product, such as EKS, has no such row rather than an empty one.
 */
const clusterItems = (c: ClusterView) => [
  {
    term: 'Status',
    value: (
      <StatusLabel
        isCompact
        status={c.status}
        reason={['Connection to the hub', statusReason(c)].filter(Boolean).join(': ')}
      />
    ),
    'data-testid': 'cluster-status',
  },
  { term: 'Data center', value: <ClusterDataCenter cluster={c} testId="cluster-data-center" /> },
  { term: 'Region', value: c.region },
  { term: 'Map position', value: <MapPosition cluster={c} />, 'data-testid': 'cluster-map-position' },
  ...(c.openshiftVersion ? [{ term: 'OpenShift version', value: c.openshiftVersion }] : []),
  { term: 'Kubernetes version', value: c.kubernetesVersion },
  { term: 'Platform', value: c.platform },
  { term: 'Product', value: c.product },
  { term: 'Added to the hub', value: c.creationTimestamp && <RelativeTime time={c.creationTimestamp} /> },
];

/**
 * Where the map puts the cluster and from what: the hub admin's annotations, or the cloud region
 * ("<lat, lon> from the cloud region"); otherwise why it isn't on the map. Without annotations it links to how a hub
 * admin sets them.
 */
const MapPosition: React.FC<{ cluster: ClusterView }> = ({ cluster: c }) => {
  const how = (
    <a href={LOCATION_DOCS_URL} target="_blank" rel="noreferrer">
      How to set a cluster&apos;s position
    </a>
  );
  if (c.latitude === undefined || c.longitude === undefined) {
    return (
      <Stack>
        <span>{c.locationProblem ? `Not on the map: ${c.locationProblem}` : 'Not on the map: no position'}</span>
        {how}
      </Stack>
    );
  }
  const at = `${c.latitude}, ${c.longitude}`;
  return isFromCloudRegion(c) ? (
    <Stack>
      <span>
        {at} <SubtleText>from the cloud region</SubtleText>
      </span>
      {how}
    </Stack>
  ) : (
    <span>{at}</span>
  );
};

/** Each distinct value once, in order. */
const distinct = (values: (string | undefined)[]) => [...new Set(values.filter((v): v is string => !!v))];

/**
 * The GPUs Kubernetes can give to pods (the hub's nvidia.com/gpu capacity), with the GPU Feature
 * Discovery count beside it when the two differ: time-slicing and MPS count each GPU once per
 * replica, so 2 GPUs time-sliced ×4 are 8 schedulable. Without that note the Capacity card and the
 * GPUs card would show two numbers for one cluster with nothing to say which is which (review).
 *
 * Under the GPU Operator's MIG strategy mixed, the device plugin advertises MIG slices as
 * nvidia.com/mig-<profile>, and nvidia.com/gpu counts only the GPUs without MIG, so the row says
 * the slices aren't counted. Wording only: the console doesn't count them (review).
 */
const schedulableGPUs = (c: ClusterView) => {
  const schedulable = gpuCount(c);
  const gpus = c.gpus;
  if (schedulable === undefined || !gpus) return schedulable;
  const mixedMIG = gpus.configurations.some((g) => g.sharing?.migStrategy === 'mixed');
  const notes: string[] = [];
  if (gpus.total !== schedulable) {
    notes.push(gpuCountText(gpus.total));
    // How the GPUs are shared, only when every configuration shares them the same way: a cluster
    // that mixes unshared and time-sliced GPUs gets the count alone. Worded as the list words it
    // ("Time-sliced ×4", "MPS ×2"). Left out under mixed MIG, whose note says more.
    const sharing = new Set(gpus.configurations.map((g) => gpuSharing(g.sharing, g.product)));
    const [how] = sharing;
    if (sharing.size === 1 && how && !mixedMIG) notes.push(how);
  }
  if (mixedMIG) notes.push('MIG slices not counted');
  return notes.length ? `${schedulable} (${notes.join(', ')})` : schedulable;
};

const capacityItems = (c: ClusterView) => {
  const cap = c.capacity ?? {};
  const alloc = c.allocatable ?? {};
  return [
    { term: 'CPU', value: withAllocatable(formatCores(cap.cpu), formatCores(alloc.cpu)) },
    { term: 'Memory', value: withAllocatable(formatGiB(cap.memory), formatGiB(alloc.memory)) },
    { term: 'Schedulable GPUs', value: schedulableGPUs(c), 'data-testid': 'cluster-gpus' },
  ];
};

const gpuItems = (g: ClusterGPUs) => [
  { term: 'Capacity', value: capacityText(g), 'data-testid': 'cluster-gpu-capacity' },
  {
    term: g.configurations.length === 1 ? 'Configuration' : 'Configurations',
    value: (
      <List isPlain data-testid="cluster-gpu-configurations">
        {g.configurations.map((c, i) => (
          // Everything that tells two configurations apart, and the index for two the backend
          // sent alike.
          <ListItem
            key={[
              c.vendor,
              c.product,
              c.memoryMib,
              c.gpusPerNode,
              c.sharing?.strategy,
              c.sharing?.replicas,
              c.sharing?.migStrategy,
              i,
            ].join('|')}
          >
            {[
              configurationText(c),
              gpuMemory(c.memoryMib) && `${gpuMemory(c.memoryMib)} each`,
              gpuSharing(c.sharing, c.product),
              // Capacity gives the nodes in all; only a mixed cluster needs each configuration's.
              g.configurations.length > 1 && `${c.nodeCount} ${c.nodeCount === 1 ? 'node' : 'nodes'}`,
            ]
              .filter(Boolean)
              .join(', ')}
          </ListItem>
        ))}
      </List>
    ),
  },
  { term: 'Manufacturer', value: distinct(g.nodes.map((n) => n.vendor)).join(', ') },
  {
    term: 'Architecture',
    value: distinct(g.nodes.map((n) => gpuArchitecture(n.family))).join(', ') || undefined,
  },
  {
    term: 'Driver',
    value: distinct(g.nodes.map((n) => driverText(n.driverVersion, n.cudaRuntimeVersion))).join(', ') || undefined,
  },
];

/** "580.105.08 (CUDA 13.0)", or whichever of the two the node reports. */
const driverText = (driver?: string, cuda?: string) =>
  driver && cuda ? `${driver} (CUDA ${cuda})` : driver || (cuda && `CUDA ${cuda}`) || undefined;

/** "Hopper (9.0)": the architecture with its compute capability, or whichever the node reports. */
const architectureText = (family?: string, compute?: string) => {
  const name = gpuArchitecture(family);
  if (name && compute) return `${name} (${compute})`;
  return name ?? compute;
};

/**
 * One row per GPU node: its name with the instance type under it, the model and its count,
 * memory, architecture, driver, sharing and readiness.
 */
const GPUNodesTable: React.FC<{ nodes: GPUNode[] }> = ({ nodes }) => (
  <Table aria-label="GPU nodes" variant="compact" data-testid="cluster-gpu-nodes">
    <Thead>
      <Tr>
        <Th width={25} modifier="wrap">
          Node
        </Th>
        <Th modifier="wrap">Model</Th>
        <Th modifier="wrap" className="console-number">
          GPUs
        </Th>
        <Th modifier="wrap">Memory</Th>
        <Th modifier="wrap">Architecture</Th>
        <Th modifier="wrap">Driver</Th>
        <Th modifier="wrap">Sharing</Th>
        <Th modifier="wrap">Status</Th>
      </Tr>
    </Thead>
    <Tbody>
      {nodes.map((n) => (
        <Tr key={n.name}>
          <Td dataLabel="Node" modifier="breakWord">
            <TableRowTitleDescription
              title={n.name}
              subtitle={
                n.instanceType && (
                  <Content component="small" className="pf-v6-u-text-color-subtle">
                    {n.instanceType}
                  </Content>
                )
              }
            />
          </Td>
          <Td dataLabel="Model">{gpuModel(n.product)}</Td>
          <Td dataLabel="GPUs" className="console-number">
            {n.count}
          </Td>
          <Td dataLabel="Memory">{gpuMemory(n.memoryMib) ?? EMPTY_VALUE}</Td>
          <Td dataLabel="Architecture">{architectureText(n.family, n.computeCapability) ?? EMPTY_VALUE}</Td>
          <Td dataLabel="Driver">{driverText(n.driverVersion, n.cudaRuntimeVersion) ?? EMPTY_VALUE}</Td>
          <Td dataLabel="Sharing">{gpuSharing(n.sharing, n.product) ?? EMPTY_VALUE}</Td>
          <Td dataLabel="Status">
            <StatusLabel isCompact status={n.ready ? 'Ready' : 'Not ready'} />
          </Td>
        </Tr>
      ))}
    </Tbody>
  </Table>
);

const NotReported: React.FC<{ what: string }> = ({ what }) => (
  <Content component="p" className="pf-v6-u-text-color-subtle">
    The backend doesn't report {what} yet.
  </Content>
);

const Section: React.FC<{ title: string; help?: React.ReactNode; children: React.ReactNode }> = ({
  title,
  help,
  children,
}) => (
  <Card isFullHeight>
    <CardBody>
      <DetailsSection title={title} help={help}>
        {children}
      </DetailsSection>
    </CardBody>
  </Card>
);

/** A cluster at /clusters/:name: its AI Grid membership, what the hub knows about it, and its health. */
export const ClusterDetailsPage: React.FC = () => {
  const { name = '' } = useParams();
  const navigate = useNavigate();
  const { data: loadedCluster, loaded, error, refresh } = useCluster(name);
  const writes = useMembershipWrites();
  const { user } = useConsoleSession();
  const [change, setChange] = useState<MembershipChange>();
  // The cluster as Add or Remove returned it, shown until a load started after that change
  // succeeds: a slow or failed reload can't bring back the membership (or the version) from before
  // it, and neither can a reload started earlier.
  const [confirmed, setConfirmed] = useState<ClusterView>();
  const lastReload = useRef(0);
  const cluster = confirmed ?? loadedCluster;

  /** Loads the cluster again; once the newest reload succeeds, it replaces the confirmed one. */
  const reload = () => {
    const id = ++lastReload.current;
    void refresh().then((ok) => {
      if (ok && id === lastReload.current) setConfirmed(undefined);
    });
  };

  /** Adds the cluster to AI Grid or removes it, then reloads it; throws for the modal to show. */
  const applyChange = async (change: MembershipChange, membership?: GridMembership) => {
    const { join } = change;
    // A 409 loads the cluster again into the open dialog, as on the Clusters list.
    const updated = await changeMembership(writes, change, membership, {
      reload: writes.loadCluster,
      onConflict: (current) => {
        if (current) {
          setChange((open) => (open?.cluster.name === current.name ? { ...open, cluster: current } : open));
        }
        reload();
      },
    });
    setConfirmed(updated);
    setChange(undefined);
    // Replace, so the notice doesn't add a second entry for this page to the browser's history.
    navigate('.', {
      replace: true,
      state: { notice: `${updated.name} ${join ? 'added to' : 'removed from'} AI Grid` },
    });
    reload();
  };

  const actions = cluster && (
    <Flex spaceItems={{ default: 'spaceItemsSm' }}>
      {cluster.consoleUrl && (
        <Button
          variant="secondary"
          component="a"
          href={cluster.consoleUrl}
          target="_blank"
          rel="noopener noreferrer"
          icon={<ExternalLinkAltIcon />}
          iconPosition="end"
        >
          OpenShift console
        </Button>
      )}
      {user?.isProviderAdmin && (
        <SimpleMenuActions
          toggleLabel="Actions"
          ariaLabel={`Actions for ${cluster.name}`}
          testId="cluster-actions"
          dropdownItems={[membershipAction(cluster, setChange)]}
        />
      )}
    </Flex>
  );

  const body = () => {
    if (!cluster) {
      return null;
    }
    return (
      <Grid hasGutter>
        <GridItem md={6}>
          <Section
            title="AI Grid"
            help="A member has the ai-grid/enabled label. The hub then installs what its role needs, and the cluster is provisioned once the hub's ai-grid-ready Policy is compliant on it."
          >
            <DetailsList items={aiGridItems(cluster)} aria-label="AI Grid membership" />
          </Section>
        </GridItem>
        <GridItem md={6}>
          <Section title="Cluster">
            <DetailsList items={clusterItems(cluster)} aria-label="Cluster" />
          </Section>
        </GridItem>
        <GridItem md={6}>
          <Section
            title="Capacity"
            help="What the cluster's nodes provide, as the hub reports it. Schedulable GPUs are the GPUs Kubernetes can give to pods: when GPUs are time-sliced or shared with MPS, each one counts once per replica."
          >
            {cluster.capacity ? (
              <DetailsList items={capacityItems(cluster)} aria-label="Capacity" />
            ) : (
              <NotReported what="this cluster's capacity" />
            )}
          </Section>
        </GridItem>
        <GridItem md={6}>
          <Section
            title="GPUs"
            help="What the cluster's GPU nodes report through their NVIDIA GPU Feature Discovery labels, which the hub's ACM Search indexes."
          >
            {cluster.gpus ? (
              <DetailsList items={gpuItems(cluster.gpus)} aria-label="GPUs" />
            ) : !cluster.capacity ? (
              <NotReported what="this cluster's GPUs" />
            ) : (
              <Content component="p" className="pf-v6-u-text-color-subtle" data-testid="cluster-gpus-not-reported">
                {gpuCount(cluster)
                  ? `The hub reports ${gpuCountText(gpuCount(cluster) ?? 0)} in this cluster's capacity, but no details for its GPU nodes: ACM Search hasn't indexed them, or the backend doesn't report them yet.`
                  : 'The hub reports no GPUs on this cluster.'}
              </Content>
            )}
          </Section>
        </GridItem>
        {cluster.gpus && (
          <GridItem>
            <Section title="GPU nodes">
              <GPUNodesTable nodes={cluster.gpus.nodes} />
            </Section>
          </GridItem>
        )}
      </Grid>
    );
  };

  return (
    <>
      <PageStateSection
        title={name}
        headerAction={actions}
        breadcrumb={
          <Breadcrumb>
            <BreadcrumbItem>
              <Link to="/clusters">Clusters</Link>
            </BreadcrumbItem>
            <BreadcrumbItem isActive>{name}</BreadcrumbItem>
          </Breadcrumb>
        }
        loaded={loaded}
        error={error}
        onRetry={reload}
        subject="Clusters"
        object="cluster"
        loadingLabel="Loading cluster"
        notFound={{
          what: 'Cluster',
          name,
          listPath: '/clusters',
          listLabel: 'Clusters',
        }}
      >
        {body()}
      </PageStateSection>
      {change && (
        <MembershipModal
          {...change}
          onConfirm={(membership) => applyChange(change, membership)}
          onClose={() => setChange(undefined)}
        />
      )}
    </>
  );
};
