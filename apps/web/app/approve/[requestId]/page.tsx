import { notFound, redirect } from 'next/navigation';

/**
 * The iOS app's "Review and sign on the Synq page" hand-off. The request id
 * is opaque (not a secret); the hub page shows the exact typed data and the
 * browser wallet signs it there. The legacy query form `/approve?p&g&n` is a
 * different page and is unaffected.
 */
export default async function ApproveHandoff({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { requestId } = await params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      requestId,
    )
  )
    notFound();
  redirect(`/approvals/${requestId}`);
}
