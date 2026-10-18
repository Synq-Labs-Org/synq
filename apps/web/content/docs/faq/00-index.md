---
title: Frequently asked questions
description: Short answers about money, safety, roles, agents, clients, devices and testnet.
---

## The basics

### Is this real money?

No. Everything runs on **Arc testnet** with test USDC. Mainnet is locked off. See [Testnet and test USDC](/docs/getting-started/testnet).

### Who is Synq for?

Freelancers, small businesses and informal groups who want an AI-assisted finance back office where humans still hold the keys.

### Do I need a crypto wallet?

Yes. You sign in and approve with an Ethereum-compatible wallet. There are no passwords. See [Sign in with a wallet](/docs/getting-started/sign-in).

### Where do I get test USDC?

From a public Arc testnet faucet for your wallet address. Synq has no Arc faucet of its own.

## Safety

### Can the AI move my money?

No. Agents have no signing keys. They propose; the Kernel checks; owners sign; contracts enforce limits. See [What agents can and cannot do](/docs/security/agents).

### I replied "yes" to the bot. Did it approve a payment?

No. Chat never approves. The bot tells you to review the exact request on the secure page and sign there.

### Does signing in approve anything?

No. The login message states that it does not approve payments or vault setup.

### Does Face ID or App Lock approve things?

No. App Lock only hides the app.

### What if a push notification is tapped by someone else?

A push contains only a generic title. Tapping navigates; the destination requires your session and membership. Nothing is approved by a tap.

### What if my session token leaks?

Web sessions last 15 minutes. Device refresh tokens rotate and reuse revokes the session. Sign out every device from Account. See [Sessions](/docs/security/sessions).

### What if an owner key is stolen?

One key is not enough if the threshold is 2 or more. Vault changes wait out a timelock, and a guardian can pause outflows. Plan an owner change. See [The vault](/docs/concepts/vault).

## Workspaces and roles

### What is the difference between Owner and Admin?

Owners sign; admins run the inbox and propose, but have no signing authority. See [Workspaces and roles](/docs/concepts/workspaces-roles).

### Can I change someone's role?

Not in the current API. Invite them again with the role you want.

### How many owners can a workspace have?

Up to 20. The default threshold is `min(owners, 3, ceil(owners / 2) + 1)`.

### Can a client be a member?

No. Clients are outside counterparties tied to a lead.

## The sales agent and clients

### What stops the sales agent from selling too cheaply?

The deterministic validator enforces price floors, a discount cap, deposit minimum, capacity and the owner threshold from your signed policy. See [Commercial policy](/docs/guides/commercial-policy).

### Can I stop it?

Yes: Take over, Freeze offers, or just do not activate a policy. Without a policy the agent hands over.

### Does "accepted" mean the deal is done?

No. It means agreed pending signatures. Both wallets must sign and the client must fund the escrow. See [Offers](/docs/guides/offers).

### Can the client see my other clients?

No.

### Is the client conversation private?

Only owners and admins of the workspace can read it, and the client is told so first. See [Privacy](/docs/security/privacy).

## Money

### Why can't I pay a new vendor right away?

New or changed vendor addresses wait 24 hours (cooling) and must be added to the vault allowlist through the timelock. See [Vendors, budgets and books](/docs/guides/finance-books).

### Why does a large payout need more signatures?

Above the signed per-payment limit, a payout takes the Safe quorum route. See [Payouts](/docs/guides/payouts).

### What does "READY" mean? Has money moved?

No. Ready means enough signatures; execution comes next. Money has moved only when the status is final on chain.

### What is the refund time on an escrow?

`now + delivery days + 30 days` when the client funds. After it, anyone may refund unreleased milestones to the client.

### Who releases escrow milestones?

The payer (the client) or an arbiter. Agreements from offers have no arbiter. See [Escrow and milestones](/docs/concepts/escrow-milestones).

## Devices and surfaces

### Why does the web page log me out after 15 minutes?

That is the web session lifetime.

### How do I sign into the iPhone app?

With a WalletConnect-capable wallet, or with a one-use code from the web page that expires in 2 minutes. See [Sign in](/docs/getting-started/sign-in).

### Can I approve in iMessage?

The extension hands every signature to the secure page.

### Which theme is default?

iPhone app: Paper. Messages extension: ASCII. Docs: ASCII. You can change them. See [Themes](/docs/guides/themes).

## Troubleshooting

### I get a 404 on a lead or lease I know exists.

Hidden things return "not found" when your role may not see them. Check your role.

### I get "Chat never approves money."

That is by design. Open the secure page.

### An approval says it expired.

Approvals have deadlines (15 minutes for payouts). Propose it again.

For codes such as `OWNER_REQUIRED` or `VENDOR_COOLING`, see [Error codes](/docs/faq/error-codes).
