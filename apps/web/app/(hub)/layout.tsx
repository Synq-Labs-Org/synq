import type { ReactNode } from 'react';
import { HubShell } from '../_hub/shell';

export const metadata = {
  title: 'Synq hub',
  description: 'Personal and business workspaces on Arc testnet',
};

export default function HubLayout({ children }: { children: ReactNode }) {
  return <HubShell>{children}</HubShell>;
}
