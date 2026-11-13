// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/grid/GridPage.tsx at 62319b8: the map at
// /ai-grid. The PoC's loading, error, and refresh state becomes useServiceData, and a failed load is
// a LoadError. The map's clusters come from AiGridPage (Clusters/List over Connect). A backend
// without the RPC (501) gets the console's not-available page, as Models and Subscriptions do.
import { useState } from 'react';
import { Divider, Flex, Stack } from '@patternfly/react-core';
import { Link } from 'react-router-dom';
import { ServiceError } from '../../api/ConsoleService';
import { useModelList } from '../models/useModels';
import type { FleetCluster } from './GridFleetView';
import { RefreshButton } from '../../components/RefreshButton';
import { RelativeTime } from '../../components/RelativeTime';
import { SubtleText } from '../../components/SubtleText';
import { PageStateSection } from '../../components/states/PageStateSection';
import { useConsoleSession } from '../../context/useConsoleSession';
import { GridFleetView } from './GridFleetView';
import { tileLayerConfig } from './tiles';

type Props = {
  /** The map's AI grid members, loaded by AiGridPage. */
  map: MapInventory;
};

/** The map's clusters: the AI grid members, when they were read, and how to read them again. */
export type MapInventory = {
  /** Absent until they have been read; a failed reload keeps the last ones. */
  clusters?: FleetCluster[];
  loaded: boolean;
  error?: Error;
  /** When the console last read them (ms since the epoch). */
  updatedAt?: number;
  refresh: () => Promise<unknown>;
};

const modelsErrorOf = (err: Error) =>
  err instanceof ServiceError && err.isNotImplemented
    ? 'Models are not available on this AI grid backend.'
    : err.message;

export const GridPage: React.FC<Props> = ({ map }) => {
  const { data: models, error: modelsLoadError, refresh: refreshModels } = useModelList();
  const { config, configError } = useConsoleSession();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([map.refresh(), refreshModels()]);
    setRefreshing(false);
  };

  // Until the config loads there is no basemap; if it can't be read, the map says tiles are unavailable. An empty tile URL draws the bundled land outline.
  const tiles = config ? tileLayerConfig(config) : configError ? null : undefined;
  const modelsError = modelsLoadError && modelsErrorOf(modelsLoadError);
  const updatedAt = map.updatedAt ? new Date(map.updatedAt).toISOString() : undefined;

  // One toolbar row: when the data was read with its Refresh beside it, as one group, then a
  // divider and the Monitoring page. The plain button's own padding spaces it from the time, and
  // with the group's smaller spacer sets the divider as far from the icon as from the link. The
  // divider keeps the icon from reading as part of the link.
  const toolbar = (
    <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsMd' }}>
      <Flex
        alignItems={{ default: 'alignItemsCenter' }}
        spaceItems={{ default: 'spaceItemsNone' }}
        spacer={{ default: 'spacerXs' }}
      >
        {updatedAt && (
          <SubtleText>
            Updated <RelativeTime time={updatedAt} />
          </SubtleText>
        )}
        <RefreshButton onRefresh={() => void refresh()} isRefreshing={!map.loaded || refreshing} />
      </Flex>
      <Divider orientation={{ default: 'vertical' }} />
      <Link to="/monitoring">View monitoring</Link>
    </Flex>
  );

  // The backend has no Clusters/List: the page is the not-available state, with nothing to refresh
  // or switch to, even if an earlier answer is still held (a backend redeployed without it).
  return (
    <PageStateSection
      title="AI grid"
      description="The AI grid connects your OpenShift clusters into a unified network to serve models and route traffic across locations."
      headerAction={toolbar}
      loaded={map.loaded}
      error={map.error}
      onRetry={() => void refresh()}
      subject="AI grid"
      object="AI grid clusters"
      notAvailableTitle="The AI grid map is not available on this AI grid backend"
      loadingLabel="Loading AI grid"
    >
      <Stack hasGutter>
        {map.clusters && (
          <GridFleetView clusters={map.clusters} models={models} modelsError={modelsError} tiles={tiles} />
        )}
      </Stack>
    </PageStateSection>
  );
};
