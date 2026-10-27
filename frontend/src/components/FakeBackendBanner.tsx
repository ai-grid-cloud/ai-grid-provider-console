import { Banner } from '@patternfly/react-core';
import { useConsoleSession } from '../context/useConsoleSession';

/** Warns that the console is talking to the fake backend, so changes reach no cluster. */
export const FakeBackendBanner: React.FC = () => {
  const { config } = useConsoleSession();
  if (!config?.fakeBackend) {
    return null;
  }
  return (
    <Banner color="yellow">
      Fake backend: data comes from fixture files, and nothing you change reaches a cluster.
    </Banner>
  );
};
