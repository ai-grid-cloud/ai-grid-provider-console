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
  /**
   * One dashboard of a project the relay reads only by name (`monitoring.extraDashboards`); undefined
   * when it isn't there or the caller may not read it.
   */
  getMonitoringDashboard(project: string, name: string): Promise<DashboardResource | undefined>;
}

/** One Monitoring tab. */
export type MonitoringTab = {
  /**
   * What `?dashboard=` holds for it: the name for the main project's dashboards (as before other
   * projects had tabs), `<project>/<name>` for another project's. Perses names hold no `/`.
   */
  key: string;
  title: string;
  dashboard: DashboardResource;
};

/** A dashboard's display name, or its name. */
export const dashboardTitle = (d: DashboardResource): string => d.spec.display?.name || d.metadata.name;

/**
 * The Monitoring tabs: the main project's `dashboard-*` dashboards, ordered by name, then the other
 * projects' in the order the chart lists them, with the chart's title when it gives one.
 */
export const monitoringTabs = (
  main: DashboardResource[],
  extra: { dashboard: DashboardResource; title?: string }[] = [],
): MonitoringTab[] => [
  ...main
    .filter((d) => d.metadata.name.startsWith('dashboard-'))
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
    .map((d) => ({ key: d.metadata.name, title: dashboardTitle(d), dashboard: d })),
  ...extra.map(({ dashboard: d, title }) => ({
    key: `${d.metadata.project}/${d.metadata.name}`,
    title: title || dashboardTitle(d),
    dashboard: d,
  })),
];

/** URL parameters a dashboard link may carry over to the tab it opens: Perses's time range and variables. */
const carriedParam = (name: string) => name.startsWith('var-') || ['start', 'end', 'refresh'].includes(name);

/**
 * Where a link inside a dashboard goes in this console. Dashboards written for the OpenShift console
 * link to its Perses viewer (`/monitoring/v2/dashboards/view?dashboard=<name>&project=<project>`), and
 * those written for Perses's own app to `/projects/<project>/dashboards/<name>`; neither page exists
 * here. When the target is one of the Monitoring tabs, the answer is that tab, with the link's time
 * range and `var-*` values; otherwise undefined, as for any other path of another app. A link that
 * names no project means `from`, the project of the dashboard it is in.
 */
export const monitoringLinkFor = (href: string, tabs: MonitoringTab[], from: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(href, 'http://console.invalid');
  } catch {
    return undefined;
  }
  let name = url.searchParams.get('dashboard') ?? undefined;
  let linkProject = url.searchParams.get('project') || from;
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
  const tab = tabs.find((t) => t.dashboard.metadata.project === linkProject && t.dashboard.metadata.name === name);
  if (!tab) {
    return undefined;
  }
  const params = new URLSearchParams({ dashboard: tab.key });
  url.searchParams.forEach((value, key) => {
    if (carriedParam(key)) params.append(key, value);
  });
  return `/monitoring?${params.toString()}`;
};
