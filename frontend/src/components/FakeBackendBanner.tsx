import { Banner } from '@patternfly/react-core';
import type { ConsoleService } from '../api/ConsoleService';
import { useServiceData } from '../hooks/useServiceData';

type Props = { service: ConsoleService };

/** Warns that the console is talking to the fake backend, so changes reach no cluster. */
export const FakeBackendBanner: React.FC<Props> = ({ service }) => {
  const [config] = useServiceData(() => service.getConfig(), undefined, 0);
  if (!config?.fakeBackend) {
    return null;
  }
  return (
    <Banner color="yellow">
      Fake backend: data comes from fixture files, and nothing you change reaches a cluster.
    </Banner>
  );
};
