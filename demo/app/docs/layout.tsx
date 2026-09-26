import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import SiteHeader from '../components/SiteHeader';
import DocsSidebar from './_components/DocsSidebar';

export const metadata: Metadata = {
  title: {
    template: '%s | unibooking',
    default: 'Documentation | unibooking',
  },
  description:
    'Guides, concepts, API reference and per-provider setup for unibooking: one TypeScript API for 17 booking and calendar providers.',
};

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <SiteHeader />
      <div className="docs-shell">
        <DocsSidebar />
        <main className="docs-main" id="main">
          {children}
        </main>
      </div>
    </div>
  );
}
