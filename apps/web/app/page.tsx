import type { Metadata } from 'next';
import { LandingHeader } from './_landing/header';
import { LandingThemeScope } from './_landing/theme';
import {
  Closing,
  Flows,
  Hero,
  Product,
  Security,
  Surfaces,
} from './_landing/sections';
import './_landing/landing.css';

export const metadata: Metadata = {
  title: 'Synq: get paid, spend safely, let agents work inside limits',
  description:
    'A testnet beta finance workspace on Arc. Owner wallets approve every money move; agents pay only inside limits a contract enforces.',
};

export default function LandingPage() {
  return (
    <LandingThemeScope>
      <a className="lp-skip" href="#main">
        Skip to content
      </a>
      <LandingHeader />
      <div id="main" className="lp-main">
        <Hero />
        <Product />
        <Flows />
        <Security />
        <Surfaces />
        <Closing />
      </div>
    </LandingThemeScope>
  );
}
