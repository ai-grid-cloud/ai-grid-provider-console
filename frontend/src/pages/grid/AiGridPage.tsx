import { useMemo } from 'react';
import { useClusterList } from '../clusters/useClusters';
import { GridPage } from './GridPage';

/**
 * The AI grid map at /ai-grid: the members among the clusters of Clusters/List (over Connect, as
 * the Clusters page shows them), by name, placed where the backend's `status.location` says.
 */
export const AiGridPage: React.FC = () => {
  const { data, loaded, error, updatedAt, refresh } = useClusterList();
  // None until both answers are in (updatedAt); after that a failed reload keeps the last ones.
  const read = updatedAt !== undefined;
  const clusters = useMemo(
    () => (read ? data.filter((c) => c.aiGridEnabled).sort((a, b) => a.name.localeCompare(b.name)) : undefined),
    [data, read],
  );
  return <GridPage map={{ clusters, loaded, error, updatedAt, refresh }} />;
};
