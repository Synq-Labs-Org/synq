import { buildSearchIndex } from '../../../lib/docs/content';

export const dynamic = 'force-static';

export function GET() {
  return Response.json(buildSearchIndex());
}
