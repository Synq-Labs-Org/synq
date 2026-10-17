---
title: Reporting security issues
description: How to report a vulnerability responsibly, what to include, and what not to do.
---

> **Note**
> The repository does not currently publish a dedicated security contact or a bug-bounty. The guidance below is the responsible way to proceed until it does. Check the repository's README and security policy for updates.

## How to report

1. **Do not post details publicly** (issues, social media, chat) before the maintainers have had a chance to fix the problem.
2. Contact the maintainers privately through the project's GitHub repository (`Synq-Labs-Org/synq`), using a private security advisory if the repository has them enabled, or the contact method listed on the maintainers' profiles.
3. Include enough to reproduce:
   - what you did, step by step, and what you expected,
   - the route, page, command or contract involved,
   - the proof level you observed (was it testnet, fixture or local?),
   - a transaction hash if one is involved,
   - the impact in your judgement.
4. Keep any proof-of-concept to **testnet** and to accounts you own.

## Please do not

- Test against other people's workspaces, leads or wallets.
- Attempt denial of service or large-scale scanning.
- Include real secrets, private keys or personal data in your report. Redact them.
- Run anything against mainnet. Synq has none.

## Things that are especially interesting

- Any path where an agent, a chat message or a notification leads to a signature, a grant or a transaction without an owner's EIP-712 signature.
- Any way to replay, reuse or mutate a grant or an approval.
- A way to read another workspace's leads, books or vault data.
- A way to turn a client into a member or a member into an owner.
- A session or refresh-token weakness.
- A way to bypass the vault's allowlist, caps, timelock or pause.
- Content in a push notification that identifies a person, price or deal.

## Known and documented limits

The limits listed on the [security overview](/docs/security) and in [Testnet-only status](/docs/security/testnet-lock) are already known. A new angle on one is still welcome.

## If you think your own workspace is affected

Sign out every device, let unsigned approvals expire, and tell your co-owners. If an owner key may be exposed, plan an owner change through the vault's timelocked process ([Keys and custody](/docs/security/keys-custody)).
