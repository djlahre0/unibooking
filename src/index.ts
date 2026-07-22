/**
 * unibooking — stateless, unified CRUD over booking & calendar providers.
 *
 * Import the core here; import adapters from their own subpath so you only
 * bundle what you use:
 *
 *   import { createRegistry, withRetry, listAll } from 'unibooking';
 *   import { google } from 'unibooking/adapters/google';
 */

// Canonical types (type-only).
export type * from './types';

// Errors (runtime values).
export {
  UnibookingError,
  isUnibookingError,
  isRetryable,
  codeForStatus,
  type ErrorCode,
  type UnibookingErrorInit,
} from './errors';

// Registry for dynamic dispatch.
export { createRegistry, type AdapterRegistry } from './registry';

// Resilience + pagination helpers.
export { withRetry, type RetryOptions } from './retry';
export { listAll, collectAll, type ListAllOptions } from './paginate';

// Time utilities (handy for consumers building canonical ranges).
export {
  addMinutes,
  endFromDuration,
  durationMinutes,
  isInstant,
  parseOffsetMinutes,
  formatWithOffset,
  assertValidRange,
} from './time';

// Adapter-authoring toolkit (for building your own adapters).
export {
  defineAdapter,
  unsupported,
  asRecord,
  asArray,
  reqString,
  type AdapterDef,
  type AdapterMethods,
} from './adapter-kit';
export {
  createHttp,
  type HttpContext,
  type HttpConfig,
  type HttpRequest,
  type AuthFn,
  type AuthResult,
  type QueryValue,
} from './http';
