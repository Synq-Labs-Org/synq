/** Liveness for container health checks and tunnels; it reads nothing. */
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(
    { status: 'ok' },
    { headers: { 'cache-control': 'no-store' } },
  );
}
