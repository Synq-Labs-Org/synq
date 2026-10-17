---
title: The AI sales agent
description: What the sales agent does in a client conversation, the rules it cannot break, and how to take over, freeze or hand back.
---

When a prospect writes, an AI assistant can answer for your business. It is designed so that the worst a confused or manipulated model can do is ask a bad question or hand the conversation to you.

## What it can do

For each client message the model returns one typed decision:

| Action          | Meaning                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `ASK`           | Ask the client a clarifying question                                          |
| `OFFER`         | Propose offer terms from your catalog                                         |
| `ACCEPT_LATEST` | Record that the client clearly accepted the latest offer, quoting its version |
| `ESCALATE`      | Hand the conversation to a person, with a reason                              |

## What it cannot do

- It **never signs** and **never moves money**. Accepting an offer in chat only moves the lead to "agreed, pending signatures".
- It **cannot change prices outside policy**. Terms it proposes go through a deterministic validator against your signed [commercial policy](/docs/guides/commercial-policy). Prices in the reply come from the validated offer, not from the model's text.
- It **does not write numbers in free text**. Any amounts in its free-text reply are stripped; if the reply was only amounts, it hands over instead.
- It **treats the client's messages as untrusted data**, not as instructions.
- It **stops the moment a person takes over**, even mid-thought: a reply it was preparing is dropped.
- It gets **two attempts per turn** to produce terms the rules accept. If the second fails, or the offer is above the agent limit, it hands over.

## Automatic handovers

The agent hands the conversation to a person ("Thanks. Someone from <business> will reply here shortly.") when:

- no sales model is configured, or there is no active commercial policy,
- the model's output is unreadable,
- the client asks for something outside the catalog or wants a person,
- the client "accepts" with no open offer,
- an offer is above the owner-approval threshold,
- no offer within your rules could be built.

Each handover is a typed [agent event](/docs/concepts/agent-events) with status `REQUIRES_OWNER`, and the lead is flagged **needs owner**.

## Handling states

| State    | Who may reply   | Offers                                                 |
| -------- | --------------- | ------------------------------------------------------ |
| `AGENT`  | The sales agent | Agent may send offers within policy                    |
| `HUMAN`  | Only staff      | Staff may send offers (owner-only above the threshold) |
| `FROZEN` | Nobody new      | No new offers                                          |

## Taking over a conversation

In the inbox choose a handling button:

| Button            | Available when  | Effect                                             |
| ----------------- | --------------- | -------------------------------------------------- |
| Take over         | Agent or Frozen | You reply; the agent stops and sends no new offers |
| Hand back         | Human or Frozen | The agent resumes, still inside the policy         |
| Freeze offers     | Agent or Human  | No new offers until unfrozen                       |
| Escalate to owner | Any             | Flags the lead for an owner                        |

Every change is versioned. The button sends the version it saw; if someone else changed it first, you get a conflict and the page reloads. Staff messages sent after a takeover are delivered to the client's private chat when a Telegram channel is bound.

> **Note**
> Staff can only send messages while handling is `HUMAN`. Writing as staff while the agent is handling returns `TAKEOVER_REQUIRED`.

## Tips

- Keep your catalog descriptions short and factual; the model sees them.
- Set a low owner-approval threshold while you learn the agent.
- Review the **Agents** tab to see every decision and rule check ([Agent activity](/docs/guides/agent-activity)).

See [Sales agent limits](/docs/concepts/sales-agent-limits) for the full list of guarantees.
