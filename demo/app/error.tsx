'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Unhandled error:', error);
  }, [error]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: '2rem',
        background: '#0a0a0f',
        color: '#e8e8f0',
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <div
        style={{
          fontSize: '2.5rem',
          marginBottom: '1rem',
        }}
      >
        ⚠️
      </div>
      <h2
        style={{
          fontSize: '1.3rem',
          fontWeight: 600,
          marginBottom: '0.5rem',
          color: '#f87171',
        }}
      >
        Something went wrong
      </h2>
      <p
        style={{
          color: '#8888a0',
          marginBottom: '1.5rem',
          textAlign: 'center',
          maxWidth: '420px',
          fontSize: '0.9rem',
          lineHeight: 1.6,
        }}
      >
        {error.message || 'An unexpected error occurred. Please try again.'}
      </p>
      <button
        onClick={reset}
        style={{
          padding: '0.6rem 1.2rem',
          background: '#8b5cf6',
          color: 'white',
          border: 'none',
          borderRadius: '8px',
          cursor: 'pointer',
          fontSize: '0.85rem',
          fontWeight: 500,
          transition: 'background 150ms ease',
        }}
        onMouseOver={(e) => (e.currentTarget.style.background = '#a78bfa')}
        onMouseOut={(e) => (e.currentTarget.style.background = '#8b5cf6')}
      >
        Try Again
      </button>
    </div>
  );
}
