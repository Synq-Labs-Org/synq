import { ArtGlyph, ArtField, ArtHero, ThemedLink, type GlyphName } from './art';
import { Flow, type FlowNode } from './flow';
import { Phone } from './phone';
import { PhoneStory, type StoryStep } from './phone-story';
import { Reveal } from './reveal';
import {
  ApprovalsScreen,
  LeadScreen,
  LeaseScreen,
  MessagesScreen,
  OverviewScreen,
  SignScreen,
  TelegramScreen,
} from './screens';

const HUB_HREF = '/personal';
const DOCS_HREF = '/docs';

export function Hero() {
  return (
    <section className="lp-hero" id="top" aria-labelledby="lp-h1">
      <div className="lp-hero-bg">
        <ArtField />
      </div>
      <div className="lp-hero-inner">
        <p className="lp-eyebrow">Testnet beta · Arc 5042002 · USDC</p>
        <div className="lp-hero-art-slot">
          <ArtHero />
        </div>
        <h1 id="lp-h1">
          Get paid. Spend safely. Let agents work inside limits.
        </h1>
        <p className="lp-lead">
          Synq is a finance workspace for freelancers and small businesses. A
          sales agent can quote inside your rules, clients fund escrow from
          their own wallets, your wallet signs every money move, and agents pay
          only within limits a contract enforces.
        </p>
        <div className="lp-cta-row">
          <ThemedLink href={DOCS_HREF} primary>
            Read the docs
          </ThemedLink>
          <ThemedLink href={HUB_HREF}>Open the web hub</ThemedLink>
        </div>
        <ul className="lp-facts">
          <li>
            <ArtGlyph name="vault" />
            <span>
              A Safe multisig vault per workspace, guarded by{' '}
              <code>SynqArcVaultPolicy</code>.
            </span>
          </li>
          <li>
            <ArtGlyph name="key" />
            <span>
              Money moves on owner wallet signatures. A chat &quot;yes&quot; is
              never an approval.
            </span>
          </li>
          <li>
            <ArtGlyph name="coin" />
            <span>
              Preproduction testnet: test USDC only, mainnet broadcasting is
              off.
            </span>
          </li>
        </ul>
      </div>
    </section>
  );
}

const STORY: StoryStep[] = [
  {
    kicker: '01 · Overview',
    title: 'See the whole business',
    screenLabel: 'workspace overview with treasury balances',
    body: (
      <p>
        The treasury shows settled, reserved, pending and quarantined balances
        separately, with how fresh the data is. Enquiries, approvals waiting for
        your signature, receivables and payables are one tap away.
      </p>
    ),
  },
  {
    kicker: '02 · Enquiries',
    title: 'Let a sales agent talk to leads',
    screenLabel: 'an enquiry where the sales agent has sent an offer',
    body: (
      <p>
        Leads arrive on private, single-use invite links. The agent replies and
        drafts offers, and a deterministic validator checks each one against the
        commercial policy you signed. Offers above your threshold need you. You
        can take over or freeze offers at any time.
      </p>
    ),
  },
  {
    kicker: '03 · Approvals',
    title: 'Money moves only on your signature',
    screenLabel: 'the approvals inbox',
    body: (
      <p>
        Every request that needs a signature lands in one inbox with its
        purpose, exact amount, expiry and how many of the required signers have
        signed. Nothing in the list signs by itself.
      </p>
    ),
  },
  {
    kicker: '04 · Signing',
    title: 'Your wallet signs the exact terms',
    screenLabel: 'an approval with the sign in your wallet button',
    body: (
      <p>
        The screen shows the typed data your wallet will sign. Only a wallet
        produces the signature, after a tap, while the app is in front. Face ID,
        App Lock, notification taps and signing in never approve a payment.
      </p>
    ),
  },
  {
    kicker: '05 · Agents',
    title: 'Agents pay inside a lease',
    screenLabel: 'an agent lease with remaining limits',
    body: (
      <p>
        A lease is a signed, on-chain permission: which action, how much per
        action, how much in the period, who can be paid, until when. The app
        reads what is left from the chain. Revoking a lease is a signed on-chain
        action from the owner&apos;s wallet.
      </p>
    ),
  },
];

export function Product() {
  return (
    <section className="lp-section" id="product" aria-labelledby="lp-h-product">
      <Reveal className="lp-section-head">
        <p className="lp-kicker">The product</p>
        <h2 id="lp-h-product">One workspace, five screens</h2>
        <p className="lp-lead">
          These are live recreations of the iOS app&apos;s screens, drawn from
          the real layouts and copy. Scroll to move through them; drag across a
          phone to turn it.
        </p>
      </Reveal>
      <PhoneStory
        steps={STORY}
        screens={[
          <OverviewScreen key="o" />,
          <LeadScreen key="l" />,
          <ApprovalsScreen key="a" />,
          <SignScreen key="s" />,
          <LeaseScreen key="le" />,
        ]}
      />
    </section>
  );
}

const GET_PAID: FlowNode[] = [
  {
    label: 'LEAD',
    title: 'A prospect starts a private chat',
    detail:
      'They open a single-use invite link on the web, Telegram or iMessage. Only you and your team see the conversation, and consent is recorded.',
    where: 'workspace.leadInvite',
  },
  {
    label: 'SALES AGENT',
    title: 'The sales agent replies',
    detail:
      'It answers questions and drafts offers. You can take over, freeze offers or hand the chat back to the agent at any time.',
    where: 'workspace.leadTakeover',
  },
  {
    label: 'POLICY CHECK',
    title: 'The offer must fit your signed policy',
    detail:
      'A deterministic validator checks price floors, maximum discount, minimum deposit, milestone count and capacity. Above your approval threshold the owner decides, never the agent.',
    where: 'CommercialPolicySchema',
  },
  {
    label: 'BOTH SIGN',
    title: 'Owner and client sign the exact terms',
    detail:
      'After the client accepts in chat, each side signs the accepted version with their own wallet. A chat message is never a signature.',
    where: 'agreements.ts · EIP-712',
  },
  {
    label: 'ESCROW FUNDED',
    title: 'The client funds escrow from their own wallet',
    detail:
      'Their wallet sends the approve and open calls to the milestone escrow. The server checks the events and token transfers on Arc before it records the deal as funded.',
    where: 'SynqMilestoneEscrow.open',
  },
  {
    label: 'MILESTONES',
    title: 'Milestones release, then pay out',
    detail:
      'The payer (or an arbiter) releases a milestone and the payee withdraws it. After the refund date anyone can return unreleased funds to the payer. A dispute freezes release for 30 days and the arbiter settles.',
    where: 'release · withdraw · refund · dispute',
  },
];

const SPEND: FlowNode[] = [
  {
    label: 'REQUEST',
    title: 'A payment is requested',
    detail:
      'A person or an agent proposes it. Agents can only propose: they hold no treasury keys and no unrestricted signer.',
    where: 'PaymentIntent',
  },
  {
    label: 'APPROVALS',
    title: 'It lands in the approvals inbox',
    detail:
      'Each signer sees the purpose, exact amount, recipient, expiry, how many have signed and who enforces the rule.',
    where: 'approvals.list · approvals.get',
  },
  {
    label: 'WALLET SIGNS',
    title: 'Owners sign with their own wallets',
    detail:
      'Each owner signs typed data in their wallet: an approval of the exact action and the Safe transaction. The Safe threshold is checked against the Safe’s current owners.',
    where: 'arc-safe-action.ts',
  },
  {
    label: 'KERNEL GRANT',
    title: 'The Kernel issues a one-use grant',
    detail:
      'Only after the current quorum signed the exact call. The grant binds chain, token, payer, recipient and amount, carries a one-use nonce and a short expiry, and is authenticated with a key agents never see.',
    where: 'arc-authority.ts',
  },
  {
    label: 'VAULT GUARD',
    title: 'The vault’s policy guard checks the call',
    detail:
      'SynqArcVaultPolicy guards the Safe: a guardian pause can freeze outflows, governance changes wait out a timelock and gas refunds are refused.',
    where: 'SynqArcVaultPolicy.sol',
  },
  {
    label: 'ON CHAIN',
    title: 'A separate executor settles on Arc',
    detail:
      'It verifies the grant, consumes the nonce before signing, records the signed transaction before broadcast and reconciles the receipt into the books.',
    where: 'workers/execution',
  },
];

const AGENT: FlowNode[] = [
  {
    label: 'OWNER SIGNS',
    title: 'The owner signs a lease',
    detail:
      'An EIP-712 lease from the owner’s wallet: the PAY action, a per-action limit, period and total budgets, who can be paid and when it expires.',
    where: 'plugins/amane · leaseTypedData',
  },
  {
    label: 'AGENT ASKS',
    title: 'The agent asks to pay',
    detail:
      'A job starts when an invoice is paid or the owner asks, for example to pay a contractor. PAY is the only action supported.',
    where: 'AmaneJobCreateSchema',
  },
  {
    label: 'LIMITS READ',
    title: 'Limits are read from the chain',
    detail:
      'What is left per action, per period and in total is read from the Amane account before anything is sent.',
    where: 'readLeaseState',
  },
  {
    label: 'CONTRACT PAYS',
    title: 'The contract enforces the lease',
    detail:
      'The payment executes only if the Amane contract accepts it: right recipient, right token, inside every limit. Otherwise it is refused.',
    where: 'Amane account contract',
  },
  {
    label: 'REVOKE',
    title: 'The owner can pause or revoke',
    detail:
      'Pausing or revoking is a signed on-chain action from the owner’s wallet. A revocation shows as confirmed only when the chain confirms it.',
    where: 'mandates · revoke-intent',
  },
  {
    label: 'RECEIPT',
    title: 'Receipt and ledger',
    detail:
      'A payment reads final only with a final chain receipt, and reconciled only with a ledger entry.',
    where: 'AgentRunDetail · Receipt',
  },
];

function FlowSection(props: {
  id: string;
  kicker: string;
  title: string;
  lead: string;
  glyph: GlyphName;
  nodes: FlowNode[];
  label: string;
  note?: string;
}) {
  return (
    <section
      className="lp-section"
      id={props.id}
      aria-labelledby={`${props.id}-h`}
    >
      <Reveal className="lp-section-head">
        <div className="lp-section-glyph">
          <ArtGlyph name={props.glyph} />
        </div>
        <p className="lp-kicker">{props.kicker}</p>
        <h2 id={`${props.id}-h`}>{props.title}</h2>
        <p className="lp-lead">{props.lead}</p>
      </Reveal>
      <Reveal>
        <Flow
          id={`${props.id}-steps`}
          nodes={props.nodes}
          label={props.label}
        />
      </Reveal>
      {props.note ? (
        <Reveal>
          <p className="lp-status-note">{props.note}</p>
        </Reveal>
      ) : null}
    </section>
  );
}

export function Flows() {
  return (
    <>
      <FlowSection
        id="get-paid"
        kicker="Flow 1"
        title="Get paid"
        lead="From a first message to released milestones, nothing binds until both sides sign the exact terms and the client funds escrow from their own wallet."
        glyph="chat"
        nodes={GET_PAID}
        label="Get paid: lead, sales agent, policy check, both sign, escrow funded, milestones"
        note="The escrow contract has no admin, no pause and no proxy. Each milestone moves exactly once."
      />
      <FlowSection
        id="spend-safely"
        kicker="Flow 2"
        title="Spend safely"
        lead="A payment needs the signatures of the people who own the vault. Software in between can only check and carry out what they signed."
        glyph="shield"
        nodes={SPEND}
        label="Spend safely: request, approvals inbox, wallet signatures, Kernel grant, vault guard, on chain"
      />
      <FlowSection
        id="agent-payments"
        kicker="Flow 3"
        title="Agent payments"
        lead="Give an agent a budget, not a key. The lease says what it can do; the contract refuses everything else."
        glyph="coin"
        nodes={AGENT}
        label="Agent payments: owner signs lease, agent asks, limits read, contract pays, revoke, receipt"
        note="Status: the Amane v2 contracts are verified on Arc testnet. The v3 authority release is not deployed, and a workspace reports not configured until it has a verified account and a live lease."
      />
    </>
  );
}

const SECURITY: { glyph: GlyphName; title: string; body: string }[] = [
  {
    glyph: 'key',
    title: 'Agents never hold treasury keys',
    body: 'Agents propose and explain. They have no unrestricted signer, and the key that authenticates execution grants stays with the Kernel and the executors.',
  },
  {
    glyph: 'shield',
    title: 'Signing in never approves money',
    body: 'Face ID, App Lock, push notifications and logging in are not approvals. Only a wallet signature over the exact request is.',
  },
  {
    glyph: 'chat',
    title: 'A chat "yes" is never an approval',
    body: 'Chat buttons, Telegram votes and model output are not signatures. The only approval input is a recovered signature from the owner.',
  },
  {
    glyph: 'vault',
    title: 'Contracts without an admin',
    body: 'The escrow has no owner, proxy or pause. The vault policy cannot be upgraded; its code changes only through a timelocked owner-quorum transaction.',
  },
  {
    glyph: 'chain',
    title: 'Fails closed',
    body: 'Grants are one-use and short-lived. If the risk service cannot be reached, high-value payments are refused rather than waved through.',
  },
  {
    glyph: 'coin',
    title: 'Everything is testnet',
    body: 'Arc testnet, chain 5042002, with test USDC that has no value. Mainnet broadcasting is switched off.',
  },
];

export function Security() {
  return (
    <section className="lp-section" id="security" aria-labelledby="lp-h-sec">
      <Reveal className="lp-section-head">
        <p className="lp-kicker">Security model</p>
        <h2 id="lp-h-sec">
          Authority comes from signatures, not from software
        </h2>
        <p className="lp-lead">
          Six rules the code is built around. They are boundaries, not promises:
          each one is enforced by a contract, a signature check or a one-use
          grant.
        </p>
      </Reveal>
      <ul className="lp-cards">
        {SECURITY.map((s, i) => (
          <Reveal key={s.title} as="li" index={i} className="lp-card">
            <div className="lp-card-glyph">
              <ArtGlyph name={s.glyph} />
            </div>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </Reveal>
        ))}
      </ul>
    </section>
  );
}

export function Surfaces() {
  return (
    <section className="lp-section" id="surfaces" aria-labelledby="lp-h-surf">
      <Reveal className="lp-section-head">
        <p className="lp-kicker">Three surfaces</p>
        <h2 id="lp-h-surf">Where you use it</h2>
        <p className="lp-lead">
          One backend and one set of rules, reached from your phone, your
          browser or a chat.
        </p>
      </Reveal>
      <div className="lp-surfaces">
        <Reveal className="lp-surface">
          <Phone
            screens={[<MessagesScreen key="m" />]}
            label="iMessage conversation with a Synq invoice card and the Synq extension open. Sample data."
          />
          <h3>iOS app and iMessage</h3>
          <p>
            A SwiftUI app and a Messages extension share one design system with
            three themes: ASCII, Paper and Holo. The extension puts group fund
            and invoice cards in the conversation and hands off to the Synq page
            for anything that needs a signature. It never signs, stores keys or
            approves. We are not linking an app store listing from this page.
          </p>
        </Reveal>
        <Reveal className="lp-surface" index={1}>
          <div
            className="lp-browser"
            role="img"
            aria-label="The web hub: overview, inbox, deals, agents, money and settings for a workspace. Sample layout."
          >
            <div className="lp-browser-bar" aria-hidden="true">
              <i />
              <i />
              <i />
              <span>/w/…/inbox</span>
            </div>
            <div className="lp-browser-body" aria-hidden="true">
              <ul>
                <li>Overview</li>
                <li className="on">Inbox</li>
                <li>Agents</li>
                <li>Money</li>
                <li>Deals</li>
                <li>Settings</li>
              </ul>
              <div>
                <b>Enquiries</b>
                <p>Orchard Row Cafe · Offer sent · Agent replying</p>
                <p>Sample Client Ltd · New · Needs you</p>
                <p className="lp-browser-note">
                  Approvals open here, where your browser wallet signs.
                </p>
              </div>
            </div>
          </div>
          <h3>Web hub</h3>
          <p>
            Overview, inbox, deals, agents, money and settings for each
            workspace, plus personal circles and notifications. Approvals open
            here, where your own browser wallet signs.
          </p>
          <ThemedLink href={HUB_HREF}>Open the web hub</ThemedLink>
        </Reveal>
        <Reveal className="lp-surface" index={2}>
          <Phone
            screens={[<TelegramScreen key="t" />]}
            label="A Telegram-style private chat with the sales agent. Sample data."
          />
          <h3>Telegram</h3>
          <p>
            Prospects can talk to your sales agent from a single-use link, and
            the same private conversation appears in your inbox. The Telegram
            adapters are tested locally; a live round trip is not yet
            demonstrated.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

export function Closing() {
  return (
    <section className="lp-closing" aria-labelledby="lp-h-close">
      <Reveal>
        <h2 id="lp-h-close">Try the testnet beta</h2>
        <p className="lp-lead">
          Read how the pieces fit together, or open the hub and look around with
          test funds.
        </p>
        <div className="lp-cta-row">
          <ThemedLink href={DOCS_HREF} primary>
            Read the docs
          </ThemedLink>
          <ThemedLink href={HUB_HREF}>Open the web hub</ThemedLink>
        </div>
      </Reveal>
      <p className="lp-fine">
        Synq is a preproduction testnet beta on Arc (chain 5042002). Test USDC
        has no value. All names, amounts and conversations on this page are
        sample data. This page shows no customer logos, metrics or testimonials.
      </p>
    </section>
  );
}
