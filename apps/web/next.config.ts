import type { NextConfig } from 'next';

const api = process.env.SYNQ_API_ORIGIN ?? 'http://127.0.0.1:3200';
const dev = process.env.NODE_ENV !== 'production';
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const config: NextConfig = {
  distDir: 'dist',
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@synq/identity', '@synq/schemas', '@synq/workspaces'],
  webpack(webpackConfig: {
    resolve: { extensionAlias?: Record<string, string[]> };
  }) {
    webpackConfig.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return webpackConfig;
  },
  async rewrites() {
    return [
      { source: '/api/v1/:path*', destination: `${api}/v1/:path*` },
      { source: '/api/v2/:path*', destination: `${api}/v2/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          {
            key: 'Permissions-Policy',
            value:
              'publickey-credentials-get=(self), publickey-credentials-create=(self)',
          },
        ],
      },
    ];
  },
};

export default config;
