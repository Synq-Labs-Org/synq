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
            components: [
              { '/': '/w/*' },
              { '/': '/personal/*' },
              { '/': '/approvals*' },
              { '/': '/deal-invite/*' },
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
