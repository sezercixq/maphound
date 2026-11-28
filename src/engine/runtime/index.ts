export {
  buildRuntimeDomEvent,
  mergeRuntimeDomEvent,
  type RuntimeDomEvent,
  type RuntimeDomKind,
  sanitizeStack,
  summarizePayloadShape,
} from './dom-guard';
export {
  buildObservedApiEvent,
  extractAuthHeaderNames,
  extractJsonShapeKeys,
  MAX_OBSERVED_API_EVENTS,
  mergeObservedApiEvent,
  normalizeHttpMethod,
  type ObservedApiEvent,
  type ObservedGraphqlInfo,
  observedEventsToEndpoints,
  parseGraphqlPayload,
} from './traffic-observer';
