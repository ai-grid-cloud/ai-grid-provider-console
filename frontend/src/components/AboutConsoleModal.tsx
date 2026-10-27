import { AboutModal, ClipboardCopy, clipboardCopyFunc, Content, ContentVariants } from '@patternfly/react-core';
import type { ConsoleConfig, User } from '../api/types';
import consoleMark from '../assets/console-mark.svg';

type Props = {
  isOpen: boolean;
  onClose: () => void;
  config?: ConsoleConfig;
  configError?: Error;
  user?: User;
  userError?: Error;
};

const LOADING = 'Loading…';
const FAILED = "Couldn't load";

/**
 * The build as the BFF reports it: the full commit SHA in CI images, `git describe` output in a
 * local build (a short SHA, maybe with `-dirty`, or a tag), or `dev` when nothing was set
 * (Makefile VERSION, Dockerfile CONSOLE_VERSION). A full SHA shows its first 7 characters, as git
 * does; the copy button copies the whole value.
 */
const ConsoleBuild: React.FC<{ version: string }> = ({ version }) => {
  if (!version || version === 'dev') {
    return <>Development build</>;
  }
  const short = /^[0-9a-f]{40}$/i.test(version) ? version.slice(0, 7) : version;
  return (
    <ClipboardCopy
      variant="inline-compact"
      copyAriaLabel="Copy the full console build"
      onCopy={(event) => clipboardCopyFunc(event, version)}
    >
      {short}
    </ClipboardCopy>
  );
};

/**
 * The About dialog (PatternFly AboutModal): what this console is, which build is running, what it
 * talks to, and who is signed in. There is no backend version row: the backend has no version RPC,
 * so it could only ever say it isn't known; add one when the backend reports its version.
 */
export const AboutConsoleModal: React.FC<Props> = ({ isOpen, onClose, config, configError, user, userError }) => {
  /** A config value, or what stands in for it while the config loads or after it failed. */
  const fromConfig = (value: (c: ConsoleConfig) => React.ReactNode) =>
    config ? value(config) : configError ? FAILED : LOADING;
  const fromUser = (value: (u: User) => React.ReactNode) => (user ? value(user) : userError ? FAILED : LOADING);
  const rows: [string, React.ReactNode][] = [
    ['Console build', fromConfig((c) => <ConsoleBuild version={c.version} />)],
    [
      'Data',
      fromConfig((c) =>
        c.fakeBackend ? 'Fake backend: fixture data; nothing you change reaches a cluster' : 'AI Grid backend',
      ),
    ],
    [
      'Monitoring',
      fromConfig(({ monitoring }) =>
        !monitoring.enabled
          ? 'Off'
          : monitoring.persesProject
            ? `On: Perses project ${monitoring.persesProject}`
            : 'On',
      ),
    ],
    ['Models namespace', fromConfig((c) => c.modelsNamespace)],
    ['Signed in as', fromUser((u) => (u.email ? `${u.username} (${u.email})` : u.username))],
    [
      'Access',
      fromUser((u) =>
        u.isProviderAdmin ? 'Provider admin (may change managed clusters on this hub)' : 'Not a provider admin',
      ),
    ],
  ];
  return (
    <AboutModal
      isOpen={isOpen}
      onClose={onClose}
      productName="Cloud Provider Admin Console"
      brandImageSrc={consoleMark}
      brandImageAlt="Cloud Provider Admin Console"
    >
      <Content>
        <Content component={ContentVariants.p}>
          Manages AI Grid on this ACM hub: its clusters, the organizations and subscriptions that use it, and the models
          it serves.
        </Content>
        <Content component={ContentVariants.dl} className="console-about-facts">
          {rows.map(([label, value]) => [
            <Content key={`${label}-term`} component={ContentVariants.dt}>
              {label}
            </Content>,
            <Content key={`${label}-value`} component={ContentVariants.dd}>
              {value}
            </Content>,
          ])}
        </Content>
      </Content>
    </AboutModal>
  );
};
