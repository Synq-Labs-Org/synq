import Foundation

/// Reads the public, nonce-gated quorum status for a card link. It sends no credentials
/// and receives only state and counts; approvals happen on the web page with a passkey.
public struct CardStatusClient {
    public init() {}

    public var session: URLSession = .shared

    public func fetch(_ link: CardLink) async throws -> CardStatus {
        guard let url = link.statusURL() else { throw URLError(.badURL) }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.httpMethod = "GET"
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(CardStatus.self, from: data)
    }
}

/// Values from the extension's Info.plist.
public struct SynqConfig {
    public let webHost: String

    public static func fromBundle(_ bundle: Bundle = .main) -> SynqConfig {
        let host = (bundle.object(forInfoDictionaryKey: "SynqWebHost") as? String) ?? ""
        return SynqConfig(webHost: host)
    }
}
