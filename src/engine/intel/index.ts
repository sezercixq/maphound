export {
  analyzeSourceFile,
  DEFAULT_INTEL_LIMITS,
  type IntelLimits,
  mergeScriptIntel,
} from './analyze';
export {
  classifyPath,
  extractComments,
  extractEndpoints,
  extractFileArtifacts,
  extractRoutes,
  MAX_COMMENTS_PER_FILE,
  MAX_ENDPOINTS_PER_FILE,
  MAX_ROUTES_PER_FILE,
} from './endpoints';
export {
  type CommentToken,
  type LexOptions,
  type LexResult,
  LineIndex,
  lex,
  lineAround,
  type StringToken,
} from './lexer';
export { MAX_NEXT_DATA_BYTES, parseNextData } from './next-data';
export { INTEL_PATTERNS } from './patterns';
export { extractSinks, MAX_SINKS_PER_FILE } from './sinks';
export {
  type CommentHit,
  ENDPOINT_CATEGORIES,
  type EndpointCategory,
  type EndpointHit,
  HINT_LEVELS,
  type HintLevel,
  HTTP_METHODS,
  type HttpMethod,
  type IntelLocation,
  type NextDataEntry,
  type NextDataSensitive,
  type NextDataSummary,
  type RouteHit,
  type RouteKind,
  type ScriptIntel,
  type SinkCategory,
  type SinkHit,
} from './types';
