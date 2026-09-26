'use client';

import { useSyncExternalStore } from 'react';
import { subscribeUiState, loadUiState, getServerUiSnapshot, type UiState } from './ui-state';

/**
 * localStorage does not exist during the server render, so reading it in a
 * `useState` initializer would make the first client render disagree with the
 * server HTML. `useSyncExternalStore` takes a separate server snapshot:
 * hydration matches the HTML, then React immediately re-renders with the real
 * values: the same pattern page.tsx already uses for its mount state.
 * https://react.dev/reference/react/useSyncExternalStore
 */
export function useUiState(): UiState {
  return useSyncExternalStore(subscribeUiState, () => loadUiState(), getServerUiSnapshot);
}
