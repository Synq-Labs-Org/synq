/** Universal links for the iOS app. Served as JSON with no redirect or extension. */
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(
    {
      applinks: {
        details: [
          {
            appIDs: [
              process.env.SYNQ_IOS_APP_ID ??
                '8NPF39H3FL.world.synqlabs.messages',
            ],
            // Keep wallet and passkey ceremonies in the browser; open the app elsewhere.
            components: [
              { '/': '/pay/*', exclude: true },
              { '/': '/approve', '?': { p: '*' }, exclude: true },
              { '/': '/workspaces*', exclude: true },
              { '/': '/send*', exclude: true },
              { '/': '/intents/*', exclude: true },
              { '/': '/api/*', exclude: true },
              { '/': '/w/*/inbox' },
              { '/': '/w/*/inbox/*' },
              { '/': '/w/*/deals/*' },
              { '/': '/w/*/agents/*' },
              { '/': '/personal' },
              { '/': '/personal/circles/*' },
              { '/': '/approve/*' },
              { '/': '/approvals' },
              { '/': '/notifications' },
              { '/': '/fund/*' },
            ],
          },
        ],
      },
    },
    {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=300',
      },
    },
  );
}
