import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Synq',
  description: 'Group membership and passkey approvals',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="bar">
          <a href="/" className="brand">
            Synq
          </a>
          <nav>
            <a href="/enroll">Create passkey</a>
            <a href="/recover">Recover</a>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
