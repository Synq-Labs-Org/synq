import type { Evidence } from './schema.js';

/**
 * Server-side check that delivered GitHub evidence exists at its source:
 * the commit (by full sha) or pull request (by number) in the named public
 * repository, read from the GitHub REST API. File hashes cannot be checked
 * here and pass through as unverified. A party never sets `verifiedBy`.
 */
export function githubEvidenceVerifier(
  fetchImpl: typeof fetch = fetch,
  opts: { token?: string; timeoutMs?: number } = {},
) {
  return async (e: Evidence): Promise<boolean> => {
    if (e.type === 'FILE_SHA256') return true;
    if (!e.repo) return false;
    const path =
      e.type === 'GITHUB_COMMIT'
        ? `commits/${e.commitSha}`
        : `pulls/${e.prNumber}`;
    const r = await fetchImpl(
      `https://api.github.com/repos/${e.repo}/${path}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'synq-dealroom',
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      },
    );
    if (!r.ok) return false;
    const body = (await r.json()) as { sha?: string; number?: number };
    return e.type === 'GITHUB_COMMIT'
      ? body.sha === e.commitSha
      : body.number === e.prNumber;
  };
}
