'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { describeV3, v3, V3Error } from '../../lib/v3';
import { useHub } from './provider';

export type Loaded<T> = {
  data: T | null;
  error: string | null;
  errorKind: V3Error['kind'] | null;
  loading: boolean;
  reload: () => Promise<void>;
};

/** GET a v3 path and parse it with a contract schema. A null path waits. */
export function useV3<S extends z.ZodType>(
  path: string | null,
  schema: S,
): Loaded<z.output<S>> {
  const schemaRef = useRef(schema);
  const [data, setData] = useState<z.output<S> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<V3Error['kind'] | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (path === null) return;
    const mine = ++seq.current;
    try {
      const result = await v3.get(path, schemaRef.current);
      if (mine !== seq.current) return;
      setData(result);
      setError(null);
      setErrorKind(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(describeV3(e));
      setErrorKind(e instanceof V3Error ? e.kind : null);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    // Fetch on mount and when the path changes; state is set after the request.
    void load();
    return () => {
      seq.current++;
    };
  }, [load]);

  return { data, error, errorKind, loading, reload: load };
}

type PageShape = { items: unknown[]; nextCursor: string | null };

export type Paged<Item> = {
  items: Item[];
  error: string | null;
  loading: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  reload: () => Promise<void>;
};

/** Cursor-paged list. `query` is already URL-encoded, without cursor. */
export function usePaged<S extends z.ZodType<PageShape>>(
  basePath: string | null,
  query: string,
  schema: S,
): Paged<z.output<S>['items'][number]> {
  type Item = z.output<S>['items'][number];
  const schemaRef = useRef(schema);
  const [items, setItems] = useState<Item[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(basePath !== null);
  const seq = useRef(0);

  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean) => {
      if (basePath === null) return;
      const mine = ++seq.current;
      const parts = [
        query,
        cursor ? `cursor=${encodeURIComponent(cursor)}` : '',
      ]
        .filter(Boolean)
        .join('&');
      try {
        const page = await v3.get(
          parts ? `${basePath}?${parts}` : basePath,
          schemaRef.current,
        );
        if (mine !== seq.current) return;
        setItems((prev) =>
          append
            ? [...prev, ...(page.items as Item[])]
            : (page.items as Item[]),
        );
        setNext(page.nextCursor);
        setError(null);
      } catch (e) {
        if (mine !== seq.current) return;
        setError(describeV3(e));
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [basePath, query],
  );

  useEffect(() => {
    // Refetch from the first page when path or filters change.
    setLoading(true);
    void fetchPage(null, false);
    return () => {
      seq.current++;
    };
  }, [fetchPage]);

  return {
    items,
    error,
    loading,
    hasMore: next !== null,
    loadMore: () => fetchPage(next, true),
    reload: () => fetchPage(null, false),
  };
}

/**
 * Refetch when the live stream reports a change for the current context
 * (or any context when `anyContext`). Bursts are collapsed into one refetch.
 */
export function useLiveRefresh(
  refetch: () => void | Promise<void>,
  options: { types?: readonly string[]; anyContext?: boolean } = {},
): void {
  const { subscribe } = useHub();
  const ref = useRef(refetch);
  const optionsRef = useRef(options);
  useEffect(() => {
    ref.current = refetch;
    optionsRef.current = options;
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = subscribe((event, inContext) => {
      const o = optionsRef.current;
      if (!inContext && !o.anyContext) return;
      if (o.types && !o.types.includes(event.type)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void ref.current(), 300);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [subscribe]);
}
