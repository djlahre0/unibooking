import type { AdapterFactory, ProviderId } from './types';

/**
 * A lookup of adapters by provider id, for dynamic dispatch (e.g. a SaaS that
 * picks an adapter per connected account). Registration is explicit — you pass
 * in the adapters you imported — so there are no import side effects and the
 * package stays fully tree-shakeable.
 */
export interface AdapterRegistry {
  /** Get an adapter, throwing if it was never registered. */
  get(id: ProviderId): AdapterFactory;
  /** Get an adapter, or `undefined` if not registered. */
  tryGet(id: ProviderId): AdapterFactory | undefined;
  has(id: ProviderId): boolean;
  ids(): ProviderId[];
}

/** Export names are camelCase while provider ids are snake_case, so the
 *  "you forgot to register this" hint can't just interpolate the id. */
const EXPORT_NAMES: Partial<Record<ProviderId, string>> = {
  microsoft_bookings: 'microsoftBookings',
};

export function createRegistry(adapters: ReadonlyArray<AdapterFactory<any>>): AdapterRegistry {
  const map = new Map<ProviderId, AdapterFactory>();
  for (const a of adapters) map.set(a.id, a as AdapterFactory);

  return {
    get(id) {
      const a = map.get(id);
      if (!a) {
        throw new Error(
          `unibooking: no adapter registered for "${id}". ` +
            `Import it (e.g. import { ${EXPORT_NAMES[id] ?? id} } from 'unibooking/adapters/${id}') ` +
            `and pass it to createRegistry([...]).`,
        );
      }
      return a;
    },
    tryGet: (id) => map.get(id),
    has: (id) => map.has(id),
    ids: () => [...map.keys()],
  };
}
