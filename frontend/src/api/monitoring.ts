import type { DashboardResource } from '@perses-dev/client';

/** Where the BFF relays the hub's Perses API (bff/internal/perses, docs/plan/bff-api.md "The Perses relay"). */
export const PERSES_API = '/perses/api';

/** The Monitoring page: the hub's Perses dashboards, read through the BFF's relay. */
export interface MonitoringService {
  /**
   * The Perses dashboards in `project`, the one project the relay reads (`monitoring.persesProject`),
   * as Perses returns them.
   */
  listMonitoringDashboards(project: string): Promise<DashboardResource[]>;
}

/** The dashboards the Monitoring page shows as tabs: the `dashboard-*` ones, ordered by name. */
export const monitoringTabs = (dashboards: DashboardResource[]): DashboardResource[] =>
  dashboards
    .filter((d) => d.metadata.name.startsWith('dashboard-'))
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));

/** A dashboard's tab title: its display name, or its name. */
export const dashboardTitle = (d: DashboardResource): string => d.spec.display?.name || d.metadata.name;

/** URL parameters a dashboard link may carry over to the tab it opens: Perses's time range and variables. */
const carriedParam = (name: string) => name.startsWith('var-') || ['start', 'end', 'refresh'].includes(name);

/**
 * Where a link inside a dashboard goes in this console. Dashboards written for the OpenShift console
 * link to its Perses viewer (`/monitoring/v2/dashboards/view?dashboard=<name>&project=<project>`), and
 * those written for Perses's own app to `/projects/<project>/dashboards/<name>`; neither page exists
 * here. When the target is one of the Monitoring tabs, the answer is that tab, with the link's time
 * range and `var-*` values; otherwise undefined, as for any other path of another app. The tabs are
 * all in `project`, the one the relay reads: a link that names another project goes nowhere here,
 * and one that names none means the project of the dashboard it is in, which is `project` too.
 */
export const monitoringLinkFor = (href: string, tabs: DashboardResource[], project: string): string | undefined => {
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
  if (linkProject && linkProject !== project) {
    return undefined;
  }
  const tab = tabs.find((d) => d.metadata.name === name);
  if (!tab) {
    return undefined;
  }
  const params = new URLSearchParams({ dashboard: tab.metadata.name });
  url.searchParams.forEach((value, key) => {
    if (carriedParam(key)) params.append(key, value);
  });
  return `/monitoring?${params.toString()}`;
};
