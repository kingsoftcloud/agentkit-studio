import { defaultNativeToolNames } from '@kingsoftcloud/agentkit-harness-core/capability-profile';

/** The Host, not model output, identifies available built-in resources. */
export function nativeDefaultToolsFromCatalog(catalog) {
  return defaultNativeToolNames(catalog.filter(item => item.source === 'studio-native' && !item.disabled
    && ['available', 'configured'].includes(item.status)).map(item => item.resourceId));
}
