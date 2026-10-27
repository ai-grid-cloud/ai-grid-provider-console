// The Perses plugins the Monitoring page renders with, bundled into the console. Perses can also
// load plugins from its server at runtime (remotePluginLoader, module federation), but that loader
// doesn't work under Vite and runs CommonJS require(), so every plugin a dashboard may use is
// listed here. A panel whose plugin is missing shows Perses's own "plugin not found" error.
//
// Not the bar chart (@perses-dev/bar-chart-plugin 0.13): its tooltip is HTML built from the series
// name, a label value from the query, without escaping, so a label could put markup on the console's
// page. Add it back once Perses escapes it. The others keep data out of HTML: the gauge and pie
// charts draw it on the canvas (the pie's tooltip escapes it), and the markdown panel sanitizes its
// HTML with DOMPurify. Loki's datasource, queries and variables are bundled ahead of the monitoring
// team's Loki dashboards and not yet tried against a Loki: the hub's Perses has none. Its queries
// draw in the time series, stat and table panels. Not the logs table (@perses-dev/logs-table-plugin
// 0.3): it imports an ansiColors.css its package doesn't ship.
import { dynamicImportPluginLoader, getPluginModuleCompoundKey } from '@perses-dev/plugin-system';
import type { PluginModuleResource } from '@perses-dev/plugin-system';
import * as gauge from '@perses-dev/gauge-chart-plugin';
import * as loki from '@perses-dev/loki-plugin';
import * as markdown from '@perses-dev/markdown-plugin';
import * as pie from '@perses-dev/pie-chart-plugin';
import * as prometheus from '@perses-dev/prometheus-plugin';
import * as stat from '@perses-dev/stat-chart-plugin';
import * as table from '@perses-dev/table-plugin';
import * as timeseries from '@perses-dev/timeseries-chart-plugin';

type PluginPackage = { getPluginModule: () => PluginModuleResource } & Record<string, unknown>;

/**
 * The registry finds a plugin by its compound key (kind, name, registry, version), so each module's
 * exports are also keyed that way, as odh-dashboard's persesPluginsLoader does.
 */
const bundled = (pkg: unknown) => {
  const mod = pkg as PluginPackage;
  const resource = mod.getPluginModule();
  return {
    resource,
    importPlugin: async () => {
      const out: Record<string, unknown> = { ...mod };
      for (const { kind, spec } of resource.spec.plugins) {
        const key = getPluginModuleCompoundKey({
          kind,
          name: spec.name,
          registry: resource.metadata.registry,
          version: resource.metadata.version,
        });
        out[key] = mod[spec.name];
      }
      return out;
    },
  };
};

export const pluginLoader = dynamicImportPluginLoader([
  bundled(prometheus),
  bundled(loki),
  bundled(timeseries),
  bundled(stat),
  bundled(table),
  bundled(gauge),
  bundled(pie),
  bundled(markdown),
]);
