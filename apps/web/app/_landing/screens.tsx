import type { ReactNode } from 'react';

/*
 * HTML recreations of real app screens. Layout and wording follow the SwiftUI
 * views in apps/ios-messages/SynqShared (Features/Business, Approvals, Agents)
 * and the iMessage card model. Every name, address and amount is sample data
 * on testnet; nothing here is read from a live service.
 */

type IconName =
  | 'home'
  | 'inbox'
  | 'deal'
  | 'agents'
  | 'money'
  | 'key'
  | 'bell'
  | 'gear';

const ICONS: Record<IconName, string> = {
  home: 'M3 11 12 3l9 8v10h-6v-6H9v6H3z',
  inbox: 'M3 4h18v12h-5l-2 3h-4l-2-3H3zM3 13h5l1 2h6l1-2h5',
  deal: 'M4 5h16v14H4zM8 9h8M8 13h5',
  agents: 'M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 21c0-4 3.5-7 8-7s8 3 8 7',
  money:
    'M12 3v18M16 7.5C16 6 14.2 5 12 5S8 6 8 8c0 4 8 3 8 8 0 2-1.8 3-4 3s-4-1-4-2.5',
  key: 'M8 14a4 4 0 1 1 3.5-6H21v3h-3v3h-3v-3h-3.5A4 4 0 0 1 8 14z',
  bell: 'M6 17V11a6 6 0 0 1 12 0v6l2 2H4zM10 21h4',
  gear: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM12 2v3M12 19v3M2 12h3M19 12h3',
};

export function Ico({ name }: { name: IconName }) {
  return (
    <svg className="sc-ico" viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

export function Badge({
  kind = 'neutral',
  children,
}: {
  kind?: 'neutral' | 'pending' | 'live' | 'approved' | 'danger';
  children: ReactNode;
}) {
  return <span className={`sc-badge sc-badge-${kind}`}>{children}</span>;
}

export function Panel({
  label,
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <div className="sc-panel">
      {label ? <span className="sc-panel-label">{label}</span> : null}
      {children}
    </div>
  );
}

export function Kv({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="sc-kv">
      <span>{k}</span>
      <b className={mono ? 'sc-mono' : undefined}>{v}</b>
    </div>
  );
}

export function Row(props: {
  icon: IconName;
  title: string;
  sub?: string;
  detail?: string;
  trail?: ReactNode;
}) {
  return (
    <div className="sc-row">
      <Ico name={props.icon} />
      <div className="sc-row-main">
        <b>{props.title}</b>
        {props.sub ? <span>{props.sub}</span> : null}
        {props.detail ? <small>{props.detail}</small> : null}
      </div>
      <div className="sc-row-trail">
        {props.trail ?? <span className="sc-arrow" aria-hidden="true" />}
      </div>
    </div>
  );
}

export function Amount({
  value,
  unit = 'USDC',
  small,
}: {
  value: string;
  unit?: string;
  small?: boolean;
}) {
  return (
    <div className={small ? 'sc-amount sc-amount-s' : 'sc-amount'}>
      {value}
      <i>{unit}</i>
    </div>
  );
}

export function Btn({
  children,
  primary,
}: {
  children: ReactNode;
  primary?: boolean;
}) {
  return (
    <div className={primary ? 'sc-btn sc-btn-primary' : 'sc-btn'}>
      <span>{children}</span>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="sc-note">{children}</p>;
}

function Label({ children, trail }: { children: ReactNode; trail?: string }) {
  return (
    <div className="sc-label">
      <span>{children}</span>
      <hr />
      {trail ? <span>{trail}</span> : null}
    </div>
  );
}

const TABS: { id: string; icon: IconName; title: string }[] = [
  { id: 'home', icon: 'home', title: 'Home' },
  { id: 'inbox', icon: 'inbox', title: 'Inbox' },
  { id: 'deals', icon: 'deal', title: 'Deals' },
  { id: 'agents', icon: 'agents', title: 'Agents' },
  { id: 'finance', icon: 'money', title: 'Money' },
];

/** The app frame: context header, content, five-tab bar (business context). */
function AppFrame({ tab, children }: { tab: string; children: ReactNode }) {
  return (
    <div className="sc-app">
      <div className="sc-ctx">
        <div>
          <b>Harbor Lane Studio</b>
          <span>Business · Owner</span>
        </div>
        <div className="sc-ctx-r">
          <Badge>Testnet</Badge>
          <Ico name="bell" />
        </div>
      </div>
      <div className="sc-body">{children}</div>
      <div className="sc-tabs">
        {TABS.map((t) => (
          <span key={t.id} className={t.id === tab ? 'on' : undefined}>
            <Ico name={t.icon} />
            {t.title}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Business home: Features/Business/BusinessHubViews.swift, WorkspaceOverviewContent. */
export function OverviewScreen() {
  return (
    <AppFrame tab="home">
      <Panel label="Treasury">
        <div className="sc-dim">Settled · spendable · Arc Testnet</div>
        <Amount value="12,480.00" />
        <div className="sc-hr" />
        <div className="sc-split">
          <span>
            <b>Reserved</b>
            <small>held for bills, deals or members</small>
          </span>
          <em>2,500.00 USDC</em>
        </div>
        <div className="sc-split">
          <span>
            <b>Pending</b>
            <small>seen, not final</small>
          </span>
          <em>400.00 USDC</em>
        </div>
      </Panel>
      <div className="sc-group">
        <Row
          icon="inbox"
          title="Enquiries"
          sub="3 open · 1 need you"
          trail={<Badge kind="pending">1</Badge>}
        />
        <Row
          icon="key"
          title="Waiting for your signature"
          sub="2 approval requests"
          trail={<Badge kind="pending">2</Badge>}
        />
        <Row
          icon="deal"
          title="Receivables"
          sub="2 open · 3,200.00 USDC"
          trail=" "
        />
        <Row
          icon="money"
          title="Payables"
          sub="1 open · 450.00 USDC"
          trail=" "
        />
      </div>
      <Label>Agent activity</Label>
      <div className="sc-group">
        <Row
          icon="agents"
          title="Paid contractor invoice"
          sub="450.00 USDC · Final"
          detail="2 min ago · LOCAL_FIXTURE"
          trail={<Badge kind="approved">Final</Badge>}
        />
      </div>
    </AppFrame>
  );
}

/** Lead detail: LeadDetailContent and OfferPanel in BusinessHubViews.swift. */
export function LeadScreen() {
  return (
    <AppFrame tab="inbox">
      <Panel label="Telegram">
        <div className="sc-split">
          <b className="sc-head">Orchard Row Cafe</b>
          <Badge>Agent replying</Badge>
        </div>
        <div className="sc-dim">Offer sent</div>
      </Panel>
      <Label>Offer versions</Label>
      <Panel label="Version 2">
        <div className="sc-split">
          <Amount value="1,800.00" small />
          <Badge kind="live">Sent</Badge>
        </div>
        <Kv k="1 × Brand sprint" v="1,800.00 USDC" />
        <Kv k="1. Deposit · due 3d" v="900.00 USDC" />
        <Kv k="2. Delivery" v="900.00 USDC" />
        <div className="sc-dim">
          By the sales agent · policy v3 · expires in 7d
        </div>
        <div className="sc-dim sc-mono">Terms 0x7a1c…e9d2</div>
      </Panel>
      <Label>Conversation</Label>
      <div className="sc-bubble theirs">
        <span>PROSPECT</span>Can you do the sprint for 1,500?
      </div>
      <div className="sc-bubble ours">
        <span>SALES AGENT</span>The lowest I can offer is 1,800 with half up
        front. Sending the exact terms.
      </div>
      <Note>
        Messages here never move money. Offers are binding only when both sides
        sign the exact version.
      </Note>
    </AppFrame>
  );
}

/** The inbox list: ApprovalRows in ApprovalViews.swift. */
export function ApprovalsScreen() {
  return (
    <div className="sc-app">
      <div className="sc-ctx">
        <div>
          <b>Approvals</b>
          <span>Requests waiting for your wallet</span>
        </div>
        <Badge>Testnet</Badge>
      </div>
      <div className="sc-body">
        <div className="sc-group">
          <Row
            icon="money"
            title="Pay a contractor"
            sub="450.00 USDC · Harbor Lane Studio"
            detail="1 of 2 signed · expires in 23h"
            trail={<Badge kind="pending">Review</Badge>}
          />
          <Row
            icon="key"
            title="Add a payout recipient"
            sub="Harbor Lane Studio"
            detail="0 of 2 signed · expires in 2d"
            trail={<Badge kind="pending">Review</Badge>}
          />
        </div>
        <Note>
          Nothing here signs by itself. Each request opens its terms; your
          wallet signs only what you tap to sign.
        </Note>
        <Note>Face ID, App Lock and signing in never approve a payment.</Note>
      </div>
    </div>
  );
}

/** One request: ApprovalTerms and ApprovalSheet. */
export function SignScreen() {
  return (
    <div className="sc-app">
      <div className="sc-ctx">
        <div>
          <b>Approval</b>
          <span>Pay a contractor</span>
        </div>
        <Badge kind="pending">1 of 2</Badge>
      </div>
      <div className="sc-body">
        <Panel label="Pay a contractor">
          <b>Pay invoice INV-0042 to a sample contractor.</b>
          <Amount value="450.00" small />
          <div className="sc-dim">on Arc Testnet · 450000000 base units</div>
          <Kv k="Recipient" v="0x4f1a…09bc" mono />
          <Kv k="Signatures" v="1 of 2" />
          <Kv k="Expires" v="Tomorrow 09:41" />
          <Kv k="Enforced by" v="Safe vault + policy guard" />
          <div className="sc-dim">
            Requires your signature: this authorises money to move under the
            terms below.
          </div>
        </Panel>
        <Label>What your wallet signs</Label>
        <div className="sc-btn sc-btn-primary">
          <span>Sign in your wallet</span>
        </div>
        <div className="sc-dim">
          Your wallet shows these exact terms again before it signs.
        </div>
        <Btn>Review and sign on the Synq page</Btn>
      </div>
    </div>
  );
}

/** Mandates tab: LeasePanel in AgentViews.swift. */
export function LeaseScreen() {
  return (
    <AppFrame tab="agents">
      <div className="sc-head">Agents</div>
      <div className="sc-dim">
        What your agents proposed, what was checked, what was signed and what
        settled.
      </div>
      <Label>Mandates</Label>
      <Panel label="Lease 0x9e3b…41af">
        <div className="sc-row-badges">
          <Badge kind="live">Active</Badge>
          <Badge>LOCAL_FIXTURE</Badge>
        </div>
        <Kv k="Per action" v="500000000 base units" mono />
        <Kv k="Left in budget" v="1500000000 base units" mono />
        <Kv k="Assets" v="USDC" mono />
        <Kv k="Actions" v="PAY" />
        <Kv k="Recipients" v="1 allowlisted" />
        <Kv k="Expires" v="30 Nov, 09:41" />
        <Kv k="Enforced by" v="0x2465…a0F6 on Arc Testnet" mono />
        <div className="sc-dim">
          Pausing or revoking a lease is a signed on-chain action from the
          owner&apos;s wallet; this screen cannot do it by itself.
        </div>
      </Panel>
    </AppFrame>
  );
}

/** A shared invoice card in Messages, with the extension open below it. */
export function MessagesScreen() {
  return (
    <div className="sc-app sc-msgs">
      <div className="sc-msg-head">
        <span>&lsaquo;</span>
        <div>
          <i>HL</i>
          <small>Harbor Lane</small>
        </div>
        <span> </span>
      </div>
      <div className="sc-msg-thread">
        <div className="sc-imsg in">Invoice for the sprint?</div>
        <div className="sc-card">
          <div className="sc-card-art" aria-hidden="true">
            {'.:-=+*#%@\n:-=+*#%@@\n-=+*#%@@%\n.:-=+*#%@'}
          </div>
          <div className="sc-card-body">
            <span className="sc-eyebrow">Invoice</span>
            <b>Brand sprint</b>
            <Amount value="900.00" small />
            <div className="sc-dim">Pay in USDC from your own wallet</div>
            <div className="sc-split">
              <Badge kind="pending">Awaiting payment</Badge>
              <small>Arc Testnet</small>
            </div>
          </div>
        </div>
        <div className="sc-imsg in">Opens the Synq page to pay.</div>
      </div>
      <div className="sc-drawer">
        <div className="sc-drawer-bar">
          <b>SYNQ</b>
          <span>シンク</span>
        </div>
        <div className="sc-drawer-row">
          <Row icon="deal" title="Create an invoice" trail=" " />
          <Row
            icon="money"
            title="Group fund"
            sub="2 of 3 approve each payment"
            trail=" "
          />
        </div>
      </div>
    </div>
  );
}

/** A Telegram-style chat for the sales agent. */
export function TelegramScreen() {
  return (
    <div className="sc-app sc-tg">
      <div className="sc-ctx">
        <div>
          <b>Harbor Lane Studio</b>
          <span>sales agent · private chat</span>
        </div>
      </div>
      <div className="sc-body">
        <div className="sc-bubble theirs">
          <span>YOU</span>Hi, I would like a quote for a brand sprint.
        </div>
        <div className="sc-bubble ours">
          <span>SALES AGENT</span>Happy to help. 1,800 USDC in two milestones,
          half up front. Review the exact terms and sign with your wallet to
          accept.
        </div>
        <div className="sc-btn">
          <span>Review terms on the Synq page</span>
        </div>
        <Note>A chat &quot;yes&quot; is never a signature.</Note>
      </div>
    </div>
  );
}

export const STORY_SCREENS = {
  overview: <OverviewScreen />,
  lead: <LeadScreen />,
  approvals: <ApprovalsScreen />,
  sign: <SignScreen />,
  lease: <LeaseScreen />,
};
