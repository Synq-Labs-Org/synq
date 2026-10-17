'use client';

import Link from 'next/link';
import { useState } from 'react';
import { NotificationPageSchema, OkSchema } from '@synq/contracts';
import { shortDate } from '../../../lib/money';
import { describeV3, v3 } from '../../../lib/v3';
import { useLiveRefresh, usePaged, useV3 } from '../../_hub/hooks';
import { Empty, Notice, PageHeader, Panel, humanize } from '../../_hub/ui';

export default function NotificationsPage() {
  const list = usePaged(
    '/v3/notifications',
    'limit=20',
    NotificationPageSchema,
  );
  const count = useV3('/v3/notifications?limit=1', NotificationPageSchema);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    await Promise.all([list.reload(), count.reload()]);
  };
  useLiveRefresh(refresh, { types: ['NOTIFICATION'], anyContext: true });

  const markRead = async (ids: string[]) => {
    if (!ids.length) return;
    setBusy(true);
    setError(null);
    try {
      await v3.post('/v3/notifications/read', OkSchema, {
        notificationIds: ids.slice(0, 200),
      });
      await refresh();
    } catch (e) {
      setError(describeV3(e));
    } finally {
      setBusy(false);
    }
  };

  const unreadShown = list.items.filter((n) => n.readAt === null);
  const unread = count.data?.unreadCount ?? null;

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle={
          unread === null
            ? undefined
            : unread === 0
              ? 'You are all caught up.'
              : `${unread} unread`
        }
        actions={
          <button
            className="hub-btn"
            disabled={busy || unreadShown.length === 0}
            onClick={() =>
              void markRead(unreadShown.map((n) => n.notificationId))
            }
          >
            Mark shown as read
          </button>
        }
      />
      <Panel
        title="Inbox"
        note="Titles are generic on purpose. Open an item to see its details after the same access checks as the rest of the hub."
      >
        {error && <Notice tone="danger">{error}</Notice>}
        {list.error && <Notice tone="danger">{list.error}</Notice>}
        {list.loading && !list.items.length && <p role="status">Loading…</p>}
        {!list.loading && !list.error && !list.items.length && (
          <Empty>No notifications yet.</Empty>
        )}
        {list.items.length > 0 && (
          <ul className="hub-list">
            {list.items.map((n) => (
              <li key={n.notificationId}>
                <Link
                  href={n.deepLink}
                  onClick={() => {
                    if (n.readAt === null) void markRead([n.notificationId]);
                  }}
                >
                  {n.readAt === null && (
                    <span className="hub-status">Unread </span>
                  )}
                  <strong>{n.title}</strong>
                </Link>
                <br />
                <small className="hub-sub">
                  {humanize(n.category)} · {shortDate(n.createdAt)}
                </small>
                {n.readAt === null && (
                  <>
                    {' '}
                    <button
                      className="hub-link"
                      disabled={busy}
                      onClick={() => void markRead([n.notificationId])}
                    >
                      Mark as read
                      <span className="hub-sr">: {n.title}</span>
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {list.hasMore && (
          <p>
            <button className="hub-btn" onClick={() => void list.loadMore()}>
              Load more
            </button>
          </p>
        )}
      </Panel>
    </>
  );
}
