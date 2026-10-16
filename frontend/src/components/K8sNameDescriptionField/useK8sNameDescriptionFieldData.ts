// Ported from krisv/ai-grid-cloud-provider-poc src/shared/components/K8sNameDescriptionField/K8sNameDescriptionField.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/ui-core/src/components/K8sNameDescriptionField/K8sNameDescriptionField.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The companion data hook, in its own module so the component file exports only components.
import * as React from 'react';
import type {
  K8sNameDescriptionFieldData,
  K8sNameDescriptionFieldUpdateFunction,
  UseK8sNameDescriptionDataConfiguration,
  UseK8sNameDescriptionFieldData,
} from './nameField';
import { handleUpdateLogic, isRouteNameTooLong, ROUTE_BASED_RESOURCE_TYPES, setupDefaults } from './nameField';

/** Companion data hook */
export const useK8sNameDescriptionFieldData = (
  configuration: UseK8sNameDescriptionDataConfiguration = {},
): UseK8sNameDescriptionFieldData => {
  const [data, setData] = React.useState<K8sNameDescriptionFieldData>(() => setupDefaults(configuration));

  // Re-sync validation when namespace changes after initial render
  const { namespace, limitNameResourceType } = configuration;
  const isRouteBased = limitNameResourceType != null && ROUTE_BASED_RESOURCE_TYPES.has(limitNameResourceType);
  if (isRouteBased && data.k8sName.state.namespace !== namespace) {
    setData((currentData) => {
      const prevNamespace = currentData.k8sName.state.namespace;
      // Only update if namespace actually changed
      if (prevNamespace === namespace) {
        return currentData;
      }
      return {
        ...currentData,
        k8sName: {
          ...currentData.k8sName,
          state: {
            ...currentData.k8sName.state,
            namespace,
            routeNameTooLong: isRouteNameTooLong(currentData.k8sName.value, namespace),
          },
        },
      };
    });
  }

  // Keep onDataChange referentially stable across namespace changes (consumers may
  // list it in useEffect deps) while still reading the latest namespace on each update.
  const namespaceRef = React.useRef(namespace);
  React.useLayoutEffect(() => {
    namespaceRef.current = namespace;
  });

  const onDataChange = React.useCallback<K8sNameDescriptionFieldUpdateFunction>(
    (key, value) => {
      setData((currentData) =>
        // Prefer the current configuration namespace over state so typing while the
        // project/namespace is resolving does not use a stale route-length check.
        handleUpdateLogic(currentData, isRouteBased ? { namespace: namespaceRef.current } : undefined)(key, value),
      );
    },
    [isRouteBased],
  );

  return { data, onDataChange };
};
