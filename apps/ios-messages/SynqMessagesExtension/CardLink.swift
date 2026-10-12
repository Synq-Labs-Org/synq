import Foundation

/// A Synq approval link carried in `MSMessage.url`: `https://<web>/approve?p=&g=&n=[&card=]`.
/// Only `p`, `g` and `n` carry meaning to the server. The embedded `card` is an
/// unverified display hint written by whoever sent the message; the extension shows it
/// as such and the web page never trusts it.
struct CardLink: Equatable {
    let proposalId: String
    let groupId: String
    let nonce: String
    let preview: SynqCard?
    let openURL: URL
    let messageURL: URL

    private static let proposalPattern = "^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$"
    private static let groupPattern = "^0x[0-9a-fA-F]{64}$"
    private static let noncePattern = "^v1\\.[rv]\\.[0-9a-z]{1,10}\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]{22}$"

    /// Parses and validates a link. `allowedHost` is the Synq web host from Info.plist;
    /// links to any other host (or not https) are refused so a card cannot open a lookalike site.
    init?(url: URL, allowedHost: String) {
        guard url.scheme == "https",
              let host = url.host, host.lowercased() == allowedHost.lowercased(),
              url.path == "/approve",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return nil }
        func value(_ name: String) -> String? { items.first(where: { $0.name == name })?.value }
        guard let p = value("p"), let g = value("g"), let n = value("n"),
              CardLink.matches(p, CardLink.proposalPattern),
              CardLink.matches(g, CardLink.groupPattern),
              CardLink.matches(n, CardLink.noncePattern)
        else { return nil }
        var open = URLComponents()
        open.scheme = "https"
        open.host = host
        open.port = url.port
        open.path = "/approve"
        open.queryItems = [URLQueryItem(name: "p", value: p), URLQueryItem(name: "g", value: g), URLQueryItem(name: "n", value: n)]
        guard let openURL = open.url else { return nil }
        proposalId = p
        groupId = g
        nonce = n
        self.openURL = openURL
        messageURL = url
        preview = value("card").flatMap { CardLink.decodePreview($0, groupId: g, proposalId: p) }
    }

    static func matches(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }

    /// A preview whose group or proposal differs from the link is discarded.
    static func decodePreview(_ encoded: String, groupId: String, proposalId: String) -> SynqCard? {
        var b64 = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64.append("=") }
        guard encoded.count <= 4096,
              let data = Data(base64Encoded: b64),
              let card = try? JSONDecoder().decode(SynqCard.self, from: data),
              card.schema == SynqCard.supportedSchema,
              card.groupId.lowercased() == groupId.lowercased()
        else { return nil }
        if card.type == "APPROVAL_PROPOSAL", card.proposalId != proposalId { return nil }
        return card
    }

    /// Public, nonce-gated quorum status: `GET /api/v1/cards/status?p&g&n` via the web origin.
    func statusURL() -> URL? {
        var c = URLComponents(url: openURL, resolvingAgainstBaseURL: false)
        c?.path = "/api/v1/cards/status"
        return c?.url
    }
}

struct CardStatus: Codable, Equatable {
    let status: String
    let state: String
    let counted: Int
    let required: Int
}
