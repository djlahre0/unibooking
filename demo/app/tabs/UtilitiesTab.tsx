'use client';

import {
  type ActionResult,
  type Connection,
  demoRegistry,
  demoWithRetry,
  demoCollectAll,
  demoListAll,
  demoErrorHelpers,
} from '../../lib/call';
import ResultBox from '../ResultBox';
import { PagesIcon, RepeatIcon, SyncIcon, WarnIcon, WrenchIcon } from '../components/icons';

export type UtilitiesTabProps = {
  selectedProvider: string;
  conn: Connection;
  defaultRange: { start: string; end: string };
  utilResult: ActionResult | null;
  setUtilResult: (r: ActionResult | null) => void;
  wrap: (
    section: string,
    fn: () => Promise<ActionResult>,
    setter: (r: ActionResult) => void,
  ) => Promise<void>;
  busy: (section: string) => boolean;
  /** How long the last call took, measured in page.tsx's `wrap`. */
  elapsedMs?: number;
};

export default function UtilitiesTab({
  selectedProvider,
  conn,
  defaultRange,
  utilResult,
  setUtilResult,
  wrap,
  busy,
  elapsedMs,
}: UtilitiesTabProps) {
  return (
    <div className="fade-in">
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="card-title">
          <span className="icon">
            <WrenchIcon size={18} />
          </span>{' '}
          Core Utilities
        </div>
        <div className="feature-list">
          <div className="feature-item">
            <span className="icon">
              <SyncIcon size={18} />
            </span>
            <div>
              <h4>createRegistry</h4>
              <p>
                Dynamic dispatch: register adapters and look them up by <code>ProviderId</code>.
                Methods: <code>get</code>, <code>tryGet</code>, <code>has</code>, <code>ids</code>.
              </p>
            </div>
          </div>
          <div className="feature-item">
            <span className="icon">
              <RepeatIcon size={18} />
            </span>
            <div>
              <h4>withRetry</h4>
              <p>
                Wrap a client for exponential backoff on transient errors. Honors{' '}
                <code>retryAfterMs</code> from RATE_LIMIT. Safe for creates only with{' '}
                <code>idempotencyKey</code>.
              </p>
            </div>
          </div>
          <div className="feature-item">
            <span className="icon">
              <PagesIcon size={18} />
            </span>
            <div>
              <h4>listAll / collectAll</h4>
              <p>
                Auto-paginate <code>listBookings</code> across every page. <code>listAll</code>{' '}
                yields via AsyncGenerator; <code>collectAll</code> returns an array.
              </p>
            </div>
          </div>
          <div className="feature-item">
            <span className="icon">
              <WarnIcon size={18} />
            </span>
            <div>
              <h4>Error Helpers</h4>
              <p>
                <code>isUnibookingError</code>, <code>isRetryable</code>, <code>codeForStatus</code>{' '}
                discriminate and map errors consistently.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="card-title">Try Them</div>
        <div className="op-row">
          <button
            className="btn btn-primary btn-sm"
            onClick={() => wrap('util', () => demoRegistry(), setUtilResult)}
            disabled={busy('util')}
          >
            <SyncIcon /> createRegistry
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => wrap('util', () => demoErrorHelpers(), setUtilResult)}
            disabled={busy('util')}
          >
            <WarnIcon /> Error Helpers
          </button>
          {selectedProvider && (
            <>
              <button
                className="btn btn-primary btn-sm"
                onClick={() =>
                  wrap(
                    'util',
                    () =>
                      demoWithRetry(selectedProvider, conn, {
                        start: defaultRange.start,
                        end: defaultRange.end,
                      }),
                    setUtilResult,
                  )
                }
                disabled={busy('util')}
              >
                <RepeatIcon /> withRetry
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() =>
                  wrap(
                    'util',
                    () =>
                      demoCollectAll(selectedProvider, conn, {
                        start: defaultRange.start,
                        end: defaultRange.end,
                      }),
                    setUtilResult,
                  )
                }
                disabled={busy('util')}
              >
                <PagesIcon /> collectAll
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() =>
                  wrap(
                    'util',
                    () =>
                      demoListAll(selectedProvider, conn, {
                        start: defaultRange.start,
                        end: defaultRange.end,
                      }),
                    setUtilResult,
                  )
                }
                disabled={busy('util')}
              >
                <PagesIcon /> listAll
              </button>
            </>
          )}
        </div>
        {!selectedProvider && (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '0.5rem' }}>
            ℹ️ Connect to a provider to unlock withRetry, collectAll, and listAll demos.
          </p>
        )}
        <ResultBox result={utilResult} label="Utility Result" elapsedMs={elapsedMs} />
      </div>
    </div>
  );
}
