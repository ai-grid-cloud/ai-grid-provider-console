import type { VariablePlugin } from '@perses-dev/plugin-system';
import type { UnknownSpec } from '@perses-dev/spec';

/**
 * The console's own list variable plugin: another list variable plugin finds the values, and this
 * one gives the values it knows a label. Perses's select shows an option's label and the dashboard
 * uses its value, so a dashboard keeps querying by value while the select reads as names.
 */
export const RELABELED_LIST_VARIABLE = 'ConsoleRelabeledListVariable';

export type RelabeledListVariableSpec = {
  /** The variable's own plugin, which finds its values. */
  plugin: { kind: string; spec: UnknownSpec };
  /** The label of each value that has one; any other value keeps the label its plugin gave it. */
  labels: Record<string, string>;
};

/**
 * The plugin, over the variable plugins `pluginFor` finds by kind (the console's bundled ones). It has no
 * OptionsEditorComponent: the console never enables Perses edit mode, and enabling it would need one.
 */
export const relabeledListVariable = (
  pluginFor: (kind: string) => VariablePlugin | undefined,
): VariablePlugin<RelabeledListVariableSpec> => ({
  getVariableOptions: async ({ plugin, labels }, ctx, abortSignal) => {
    const inner = pluginFor(plugin.kind);
    if (!inner) {
      throw new Error(`The console has no variable plugin ${plugin.kind}.`);
    }
    const { data } = await inner.getVariableOptions(plugin.spec, ctx, abortSignal);
    return {
      data: data.map((option) =>
        Object.hasOwn(labels, option.value) ? { ...option, label: labels[option.value] } : option,
      ),
    };
  },
  dependsOn: ({ plugin }, ctx) => pluginFor(plugin.kind)?.dependsOn?.(plugin.spec, ctx) ?? {},
  createInitialOptions: () => ({ plugin: { kind: 'StaticListVariable', spec: { values: [] } }, labels: {} }),
});
