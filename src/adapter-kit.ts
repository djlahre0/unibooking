import type {
  AdapterFactory,
  BookingClient,
  Capabilities,
  ClientOptions,
  CredsInput,
  CustomerOps,
  ProviderCredentials,
  ProviderId,
} from './types';
import { createHttp, type AuthFn, type HttpConfig, type HttpContext } from './http';
import { UnibookingError } from './errors';

/** The method set an adapter implements (everything on BookingClient except the
 *  static `id`/`capabilities`, which `defineAdapter` attaches). */
export interface AdapterMethods {
  createBooking: BookingClient['createBooking'];
  getBooking: BookingClient['getBooking'];
  updateBooking: BookingClient['updateBooking'];
  cancelBooking: BookingClient['cancelBooking'];
  listBookings: BookingClient['listBookings'];
  searchAvailability: BookingClient['searchAvailability'];
  customers?: CustomerOps;
}

export interface AdapterDef<TCreds extends ProviderCredentials> {
  id: ProviderId;
  capabilities: Capabilities;
  baseUrl: string;
  auth: AuthFn<TCreds>;
  requestIdHeader?: string;
  parseError?: HttpConfig<TCreds>['parseError'];
  /** Build the method implementations against a ready HTTP context. */
  build: (http: HttpContext<TCreds>) => AdapterMethods;
}

/** Wire an adapter definition into a callable `AdapterFactory`. */
export function defineAdapter<TCreds extends ProviderCredentials>(
  def: AdapterDef<TCreds>,
): AdapterFactory<TCreds> {
  const impl = (creds: CredsInput<TCreds>, options?: ClientOptions): BookingClient => {
    const http = createHttp<TCreds>({
      provider: def.id,
      baseUrl: options?.baseUrl ?? def.baseUrl,
      creds,
      auth: def.auth,
      options,
      ...(def.requestIdHeader !== undefined ? { requestIdHeader: def.requestIdHeader } : {}),
      ...(def.parseError !== undefined ? { parseError: def.parseError } : {}),
    });
    const m = def.build(http);
    return {
      id: def.id,
      capabilities: def.capabilities,
      createBooking: m.createBooking,
      getBooking: m.getBooking,
      updateBooking: m.updateBooking,
      cancelBooking: m.cancelBooking,
      listBookings: m.listBookings,
      searchAvailability: m.searchAvailability,
      ...(m.customers ? { customers: m.customers } : {}),
    };
  };
  return Object.assign(impl, { id: def.id, capabilities: def.capabilities });
}

/** Throw a consistent UNSUPPORTED error (for capabilities a provider lacks). */
export function unsupported(provider: ProviderId, capability: string): never {
  throw new UnibookingError({
    provider,
    code: 'UNSUPPORTED',
    message: `${provider} does not support ${capability}`,
  });
}

// --- Response validation helpers -------------------------------------------
// Adapters map untyped provider JSON. These assert the fields we actually read
// and throw UPSTREAM("unexpected response shape") instead of silently emitting
// a malformed Booking.

export function asRecord(v: unknown, provider: ProviderId, ctx: string): Record<string, any> {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, any>;
  }
  throw new UnibookingError({
    provider,
    code: 'UPSTREAM',
    message: `${ctx}: expected an object, got ${Array.isArray(v) ? 'array' : typeof v}`,
  });
}

export function asArray(v: unknown, provider: ProviderId, ctx: string): any[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  throw new UnibookingError({
    provider,
    code: 'UPSTREAM',
    message: `${ctx}: expected an array, got ${typeof v}`,
  });
}

export function reqString(v: unknown, provider: ProviderId, ctx: string): string {
  if (typeof v === 'string' && v.length > 0) return v;
  throw new UnibookingError({
    provider,
    code: 'UPSTREAM',
    message: `${ctx}: expected a non-empty string, got ${typeof v}`,
  });
}
