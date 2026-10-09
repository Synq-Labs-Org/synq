import type { NextConfig } from 'next';

const api = process.env.SYNQ_API_ORIGIN ?? 'http://127.0.0.1:3200';

const config: NextConfig = {
  distDir: 'dist',
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@synq/identity', '@synq/schemas'],
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
    return [{ source: '/api/v1/:path*', destination: `${api}/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
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
