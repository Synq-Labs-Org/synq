import Foundation

/// Turns a universal link (or a pasted link) into an in-app destination.
/// Only https links on the configured Synq host are accepted. The ids in a link
/// are untrusted: the destination screen asks the server, which checks the
/// session and membership, and an id the person may not see reads "not found".
public enum SynqLinkRouter {
    public enum Result: Equatable {
        case destination(SynqDestination)
        /// A group fund link (`/fund/<id>#k=…`): opened in the app's fund screens.
        case fund(FundLink)
        /// Another page on the Synq site (checkout, legacy review cards): opened in the browser.
        case web(URL)
        case rejected
    }

    static let idPattern = "^[A-Za-z0-9_:.-]{1,128}$"

    public static func route(_ url: URL, host: String) -> Result {
        guard url.scheme == "https", let h = url.host?.lowercased(), h == host.lowercased(), url.user == nil
        else { return .rejected }
        if let fund = FundLink(url: url, allowedHost: host) { return .fund(fund) }
        let p = url.path.split(separator: "/").map(String.init)
        func ok(_ s: String) -> Bool { s.range(of: idPattern, options: .regularExpression) != nil }
        switch p.count {
        case 3 where p[0] == "w" && p[2] == "inbox" && ok(p[1]):
            return .destination(.inbox(workspaceId: p[1]))
        case 4 where p[0] == "w" && ok(p[1]) && ok(p[3]):
            switch p[2] {
            case "inbox": return .destination(.lead(workspaceId: p[1], leadId: p[3]))
            case "deals": return .destination(.deal(workspaceId: p[1], dealId: p[3]))
            case "agents": return .destination(.agentRun(workspaceId: p[1], runId: p[3]))
            default: break
            }
        case 3 where p[0] == "personal" && p[1] == "circles" && ok(p[2]):
            return .destination(.circle(circleId: p[2]))
        case 2 where p[0] == "approve" && ok(p[1]):
            return .destination(.approval(requestId: p[1]))
        case 1 where p[0] == "approvals":
            return .destination(.approvals)
        case 1 where p[0] == "notifications":
            return .destination(.notifications)
        case 1 where p[0] == "personal":
            return .destination(.personalHome)
        default:
            break
        }
        // Any other page on the Synq host stays on the web (query and fragment kept as sent).
        return .web(url)
    }
}
