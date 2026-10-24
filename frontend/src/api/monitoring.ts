import type { DashboardResource } from '@perses-dev/client';

/** Where the BFF relays the hub's Perses API (bff/internal/perses, docs/plan/bff-api.md "The Perses relay"). */
export const PERSES_API = '/perses/api';

/** The Monitoring page: the hub's Perses dashboards, read through the BFF's relay. */
export interface MonitoringService {
  /**
   * The Perses dashboards in `project`, or in every project the caller may read when it's empty,
   * as Perses returns them.
   */
  listMonitoringDashboards(project: string): Promise<DashboardResource[]>;
}

/** The dashboards the Monitoring page shows as tabs: the `dashboard-*` ones, ordered by name. */
export const monitoringTabs = (dashboards: DashboardResource[]): DashboardResource[] =>
  dashboards
    .filter((d) => d.metadata.name.startsWith('dashboard-'))
    .sort((a, b) =>
      a.metadata.name === b.metadata.name
        ? a.metadata.project.localeCompare(b.metadata.project)
        : a.metadata.name.localeCompare(b.metadata.name),
    );

/** A dashboard's tab title: its display name, or its name. */
export const dashboardTitle = (d: DashboardResource): string => d.spec.display?.name || d.metadata.name;

/** The `?dashboard=` value that selects a tab: the name, with the project when it isn't the configured one. */
export const dashboardKey = (d: DashboardResource, project: string): string =>
  project ? d.metadata.name : `${d.metadata.project}/${d.metadata.name}`;

/** URL parameters a dashboard link may carry over to the tab it opens: Perses's time range and variables. */
const carriedParam = (name: string) => name.startsWith('var-') || ['start', 'end', 'refresh'].includes(name);

/**
 * Where a link inside a dashboard goes in this console. Dashboards written for the OpenShift console
 * link to its Perses viewer (`/monitoring/v2/dashboards/view?dashboard=<name>&project=<project>`), and
 * those written for Perses's own app to `/projects/<project>/dashboards/<name>`; neither page exists
 * here. When the target is one of the Monitoring tabs, the answer is that tab, with the link's time
 * range and `var-*` values; otherwise undefined, as for any other path of another app. A link that
 * names no project means the project of the dashboard it is in (`fromProject`), when that has the
 * dashboard; otherwise the one tab of that name, if only one has it.
 */
export const monitoringLinkFor = (
  href: string,
  tabs: DashboardResource[],
  project: string,
  fromProject: string,
): string | undefined => {
  let url: URL;
  try {
    url = new URL(href, 'http://console.invalid');
  } catch {
    return undefined;
  }
  let name = url.searchParams.get('dashboard') ?? undefined;
  let linkProject = url.searchParams.get('project') ?? undefined;
  const persesApp = url.pathname.match(/^\/projects\/([^/]+)\/dashboards\/([^/]+)\/?$/);
  if (persesApp) {
    try {
      linkProject = decodeURIComponent(persesApp[1]);
      name = decodeURIComponent(persesApp[2]);
    } catch {
      // A malformed escape such as `%` alone: no dashboard has that name.
      return undefined;
    }
  } else if (!url.pathname.endsWith('/dashboards/view')) {
    return undefined;
  }
  const named = tabs.filter((d) => d.metadata.name === name);
  const inProject = (p: string) => named.find((d) => d.metadata.project === p);
  const tab = linkProject
    ? inProject(linkProject)
    : (inProject(fromProject) ?? (named.length === 1 ? named[0] : undefined));
  if (!tab) {
    return undefined;
  }
  const params = new URLSearchParams({ dashboard: dashboardKey(tab, project) });
  url.searchParams.forEach((value, key) => {
    if (carriedParam(key)) params.append(key, value);
  });
  return `/monitoring?${params.toString()}`;
};
