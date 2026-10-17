import Foundation

// Host-side check (macOS, Command Line Tools only): the extension's Foundation-only
// model code decodes the payload the backend's native renderer produces, and refuses
// tampered or foreign links. UI code needs the iOS SDK and is only syntax-checked.

struct NativeCardPayload: Decodable {
    let schema: String
    let card: SynqCard
    let openUrl: String?
    let messageUrl: String?
}

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

let path = CommandLine.arguments.dropFirst().first ?? "Checks/native-card-fixture.json"
let data = try Data(contentsOf: URL(fileURLWithPath: path))
let payload = try JSONDecoder().decode(NativeCardPayload.self, from: data)
check(payload.schema == "synq.native-card/v1", "payload schema")
check(payload.card.schema == SynqCard.supportedSchema, "card schema")
check(payload.card.amount == CardMoney(amount: "1.5", symbol: "AUSD"), "exact amount string survives decoding")
check(payload.card.lines.contains("1/2 verified approvals"), "quorum line")

let messageURL = URL(string: payload.messageUrl!)!
let link = CardLink(url: messageURL, allowedHost: "synq.example")
check(link != nil, "message URL parses as a card link")
check(link?.preview == payload.card, "embedded preview decodes to the same card")
check(link?.openURL.absoluteString == payload.openUrl, "open URL carries only p, g, n")
check(link?.statusURL()?.path == "/api/v1/cards/status", "status URL")
check(CardLink(url: messageURL, allowedHost: "evil.example") == nil, "foreign host refused")
let http = URL(string: payload.messageUrl!.replacingOccurrences(of: "https://", with: "http://"))!
check(CardLink(url: http, allowedHost: "synq.example") == nil, "plain http refused")
let otherGroup = payload.messageUrl!.replacingOccurrences(of: "g=0xa1a1", with: "g=0xb2b2")
let swapped = CardLink(url: URL(string: otherGroup)!, allowedHost: "synq.example")
check(swapped != nil && swapped?.preview == nil, "preview for another group is discarded")
let noNonce = payload.openUrl!.replacingOccurrences(of: "&n=", with: "&x=")
check(CardLink(url: URL(string: noNonce)!, allowedHost: "synq.example") == nil, "link without nonce refused")

// G2/G12: native contracts accept integer server timestamps and empty forming workspaces.
let sessionData = try JSONSerialization.data(withJSONObject: ["token": String(repeating: "a", count: 64), "principalId": "wallet:contract-check", "expiresAt": 2_000_000_000])
let workspaceSession = try JSONDecoder().decode(WorkspaceSession.self, from: sessionData)
check(workspaceSession.expiresAt == 2_000_000_000, "workspace integer expiry contract")
let workspaceData = try JSONSerialization.data(withJSONObject: ["id": UUID().uuidString, "displayName": "New workspace", "kind": "GROUP", "chainId": 5042002, "status": "FORMING", "vault": NSNull(), "threshold": NSNull()])
let workspace = try JSONDecoder().decode(WorkspaceSummary.self, from: workspaceData)
check(workspace.chainId == 5042002 && workspace.vault == nil && workspace.threshold == nil, "workspace forming state has no fabricated vault")

runParserChecks(check: check)

if failures > 0 { exit(1) }
print("native card and command checks passed")

// Workspace money stays exact beyond floating-point integer precision.
check(workspaceUSDC("9007199254740993123456") == "9007199254740993.123456 USDC", "workspace exact large USDC")
check(workspaceUSDC("1") == "0.000001 USDC", "workspace smallest USDC unit")
check(workspaceUSDC("0") == "0 USDC", "workspace zero USDC")
check(workspaceUSDC("1e6") == "Unknown amount", "workspace malformed money refused")
let nativeInvoice = try JSONDecoder().decode(WorkspaceInvoice.self, from: JSONSerialization.data(withJSONObject: ["invoiceId": "inv_contract", "number": "INV-1", "status": "PAID", "reconciliation": "FINALIZED", "total": "10000", "amountDue": "0"]))
check(nativeInvoice.total == "10000" && nativeInvoice.reconciliation == "FINALIZED", "workspace invoice wire contract keeps integer strings and finality")
let nativePayout = try JSONDecoder().decode(WorkspacePayout.self, from: JSONSerialization.data(withJSONObject: ["data": ["id": UUID().uuidString, "amount": "50000", "purpose": "Accepted work"], "state": "REVIEW", "reason": NSNull(), "txHash": NSNull()]))
check(nativePayout.state == "REVIEW" && nativePayout.txHash == nil, "workspace unsigned request is not a paid receipt")
let nativeSnapshot = try JSONDecoder().decode(WorkspaceSnapshot.self, from: JSONSerialization.data(withJSONObject: ["world": ["builtAt": 2000000000, "treasury": ["balances": ["value": [], "meta": ["freshness": "UNKNOWN", "source": "indexer", "observedAt": NSNull()]], "availableToSpend": ["value": NSNull(), "meta": ["freshness": "UNKNOWN", "source": "missing obligations", "observedAt": NSNull()]]], "decision": ["decisionGrade": false, "reasons": ["Payables unavailable"]]], "riskCases": [], "deals": NSNull()]))
check(nativeSnapshot.world.treasury.balances.meta.observedAt == nil && nativeSnapshot.world.treasury.availableToSpend.value == nil && !nativeSnapshot.world.decision.decisionGrade, "workspace missing sources stay unknown across native contract")
let nativeGroup = try JSONDecoder().decode(WorkspaceGroup.self, from: JSONSerialization.data(withJSONObject: ["contributions": [["id": UUID().uuidString, "mine": true, "member": "0x5C07…4A3B", "amount": "4000", "state": "PAID", "note": "trip", "createdAt": 1, "paidAt": 2]], "balances": [["member": "0x5C07…4A3B", "mine": true, "amount": "4000"]], "refunds": [["id": UUID().uuidString, "mine": true, "recipient": "0x5C07474fc29E37fCEb82F6862Cb34594574A4A3B", "amount": "4000", "state": "PAID", "actionId": NSNull(), "txHash": NSNull()]]]))
check(nativeGroup.balances.first?.amount == "4000" && nativeGroup.refunds.first?.state == "PAID", "workspace group fund wire contract keeps exact shares and refunds")
let nativeSwap = try JSONDecoder().decode(WorkspaceSwap.self, from: JSONSerialization.data(withJSONObject: ["id": UUID().uuidString, "workspaceId": UUID().uuidString, "state": "DONE", "data": ["from": "USDC", "to": "EURC", "amountIn": "2000", "slippageBps": 100, "estimatedOut": "2316", "minOut": "2292", "step": NSNull()], "approveActionId": NSNull(), "executeActionId": NSNull(), "evidence": ["hash": "0xabc", "spent": "2000", "received": "2315"], "lastError": NSNull()]))
check(nativeSwap.evidence?.received == "2315" && nativeSwap.data.minOut == "2292", "workspace swap wire contract keeps the received amount and floor")
let nativeBooks = try JSONDecoder().decode(WorkspaceBooks.self, from: JSONSerialization.data(withJSONObject: ["payables": [["id": UUID().uuidString, "vendorId": UUID().uuidString, "number": "INV-1", "amount": "3000", "issuedOn": "2026-10-17", "dueOn": "2026-10-17", "reference": NSNull(), "payTo": "0x030c", "status": "PAID"]], "obligations": [], "bills": []]))
check(nativeBooks.payables.first?.status == "PAID", "workspace books wire contract keeps payable status")
