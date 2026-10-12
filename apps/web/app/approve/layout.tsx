import type { ReactNode } from 'react';

// Link previews (iMessage, Telegram) fetch this page unauthenticated, so the
// metadata is generic and never reveals proposal details.
export const metadata = {
  title: 'Synq: review a group proposal',
  description: 'Sign in with your passkey to see and approve this proposal.',
  openGraph: {
    title: 'Synq',
    description: 'Review a group proposal. Sign in to see details.',
  },
  robots: { index: false, follow: false },
};

export default function ApproveLayout({ children }: { children: ReactNode }) {
  return children;
}
