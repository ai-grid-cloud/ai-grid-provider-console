// The Perses plugins the Monitoring page renders with, bundled into the console. Perses can also
// load plugins from its server at runtime (remotePluginLoader, module federation), but that loader
// doesn't work under Vite and runs CommonJS require(), so every plugin a dashboard may use is
// listed here. A panel whose plugin is missing shows Perses's own "plugin not found" error.
//
// The bar chart is patched (patches/@perses-dev__bar-chart-plugin@*.patch, pnpm's patchedDependencies
// in pnpm-workspace.yaml) to escape names in its tooltip: ECharts renders a tooltip formatter's string
// as HTML, so the patch escapes the category and series names and the marker color in it (& < > " '),
// as the pie chart already does, and a name such as "Fast <1s" shows as written. Drop the patch once
// a Perses release escapes them the same way. The gauge and pie charts draw on the canvas, and the
// markdown panel sanitizes its HTML with DOMPurify. Loki's datasource, queries and variables are bundled ahead of the monitoring
// team's Loki dashboards and not yet tried against a Loki: the hub's Perses has none. Its queries
// draw in the time series, stat and table panels. Not the logs table (@perses-dev/logs-table-plugin
// 0.3): it imports an ansiColors.css its package doesn't ship. The static list variable offers the
// values its dashboard lists, as text in Perses's variable select. One plugin is the console's own:
// the relabeled list variable (relabeledVariable.ts), which names the organization IDs the Usage
// dashboard filters by.
import { dynamicImportPluginLoader, getPluginModuleCompoundKey } from '@perses-dev/plugin-system';
import type { PluginModuleResource, VariablePlugin } from '@perses-dev/plugin-system';
import * as bar from '@perses-dev/bar-chart-plugin';
import * as gauge from '@perses-dev/gauge-chart-plugin';
import * as loki from '@perses-dev/loki-plugin';
import * as markdown from '@perses-dev/markdown-plugin';
import * as pie from '@perses-dev/pie-chart-plugin';
import * as prometheus from '@perses-dev/prometheus-plugin';
import * as stat from '@perses-dev/stat-chart-plugin';
import * as staticList from '@perses-dev/static-list-variable-plugin';
import * as table from '@perses-dev/table-plugin';
import * as timeseries from '@perses-dev/timeseries-chart-plugin';
import { RELABELED_LIST_VARIABLE, relabeledListVariable } from './relabeledVariable';

type PluginPackage = { getPluginModule: () => PluginModuleResource } & Record<string, unknown>;

/** The plugins of a module, keyed by the registry's compound key as well as by their name. */
const keyed = (resource: PluginModuleResource, mod: Record<string, unknown>) => {
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
};

/**
 * The registry finds a plugin by its compound key (kind, name, registry, version), so each module's
 * exports are also keyed that way, as odh-dashboard's persesPluginsLoader does.
 */
const bundled = (pkg: PluginPackage) => {
  const resource = pkg.getPluginModule();
  return { resource, importPlugin: async () => keyed(resource, pkg) };
};

const packages = [
  prometheus,
  loki,
  staticList,
  timeseries,
  stat,
  bar,
  table,
  gauge,
  pie,
  markdown,
] as unknown as PluginPackage[];

/** A bundled variable plugin by its kind, such as LokiLabelValuesVariable. */
const variablePlugin = (kind: string): VariablePlugin | undefined => {
  const pkg = packages.find((p) =>
    p.getPluginModule().spec.plugins.some((plugin) => plugin.kind === 'Variable' && plugin.spec.name === kind),
  );
  return pkg?.[kind] as VariablePlugin | undefined;
};

/** The console's own plugins, as one module. */
const consolePlugins = (() => {
  const resource: PluginModuleResource = {
    kind: 'PluginModule',
    metadata: { name: 'ai-grid-provider-console', version: '0.0.0' },
    spec: {
      plugins: [
        { kind: 'Variable', spec: { name: RELABELED_LIST_VARIABLE, display: { name: 'Relabeled list variable' } } },
      ],
    },
  };
  const mod = { [RELABELED_LIST_VARIABLE]: relabeledListVariable(variablePlugin) };
  return { resource, importPlugin: async () => keyed(resource, mod) };
})();

export const pluginLoader = dynamicImportPluginLoader([...packages.map(bundled), consolePlugins]);
