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

runParserChecks(check: check)

if failures > 0 { exit(1) }
print("native card and command checks passed")
