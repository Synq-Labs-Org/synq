import Combine
import Foundation
import ReownAppKit
import SynqContracts
import SynqShared
import UIKit
import WalletConnectSign

/// The person's own wallet, reached with WalletConnect (Reown AppKit): they pick a
/// wallet app, approve the connection there, and every signature is approved
/// again in that wallet, which shows the exact typed data. Nothing here holds a
/// key. Used for sign-in (`WorkspaceLogin`) and for approvals, through two
/// separate ports so a sign-in signature can never stand in for an approval.
@MainActor
final class WalletConnectSigner: WalletApprovalPort, WalletLoginPort {
    static let arcChainId = 5042002
    static let arc = Chain(chainName: "Arc Testnet", chainNamespace: "eip155", chainReference: "5042002",
                           requiredMethods: [], optionalMethods: ["eth_signTypedData_v4"], events: ["accountsChanged", "chainChanged"],
                           token: .init(name: "USDC", symbol: "USDC", decimal: 18),
                           rpcUrl: "https://rpc.testnet.arc.network", blockExplorerUrl: "https://testnet.arcscan.app", imageId: "")

    private let projectId: String
    private let host: String
    private var configured = false

    /// nil when the build has no project id (then both ports say "not configured").
    init?(projectId: String?, host: String) {
        guard let projectId, projectId.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil else { return nil }
        self.projectId = projectId
        self.host = host
    }

    private func configureIfNeeded() throws {
        guard !configured else { return }
        let metadata = AppMetadata(
            name: "Synq", description: "Sign Synq approvals with your own wallet", url: "https://\(host)",
            icons: ["https://\(host)/icon.png"],
            redirect: try AppMetadata.Redirect(native: "synq-wallet://", universal: nil))
        guard let arc = Blockchain("eip155:\(Self.arcChainId)") else { throw WalletApprovalError.notConfigured("Arc testnet is not available.") }
        AppKit.configure(
            projectId: projectId, metadata: metadata, crypto: SynqKeccakCrypto(),
            sessionParams: SessionParams(namespaces: [
                "eip155": ProposalNamespace(chains: [arc], methods: ["eth_signTypedData_v4"], events: ["accountsChanged", "chainChanged"]),
            ]),
            authRequestParams: nil, coinbaseEnabled: false)
        AppKit.instance.disableAnalytics()
        AppKit.instance.addChainPreset(Self.arc)
        AppKit.instance.selectChain(Self.arc)
        configured = true
    }

    // MARK: Availability

    var availability: Capability {
        Capability(status: .available,
                   reason: "Signs with your own wallet through WalletConnect. Your wallet shows the exact terms before it signs.")
    }

    // MARK: Connection

    /// The connected account, connecting first (wallet picker) when needed.
    private func connectedAddress() async throws -> String {
        try configureIfNeeded()
        if let address = AppKit.instance.getAddress(), !AppKit.instance.getSessions().isEmpty { return address }
        AppKit.present()
        let settled: Bool = try await withCheckedThrowingContinuation { continuation in
            var done = false
            var subs = Set<AnyCancellable>()
            func finish(_ r: Result<Bool, Error>) {
                guard !done else { return }
                done = true
                subs.removeAll()
                continuation.resume(with: r)
            }
            AppKit.instance.sessionSettlePublisher.receive(on: DispatchQueue.main)
                .sink { _ in finish(.success(true)) }.store(in: &subs)
            AppKit.instance.sessionRejectionPublisher.receive(on: DispatchQueue.main)
                .sink { _ in finish(.failure(WalletApprovalError.cancelled)) }.store(in: &subs)
            DispatchQueue.main.asyncAfter(deadline: .now() + 180) { finish(.failure(WalletApprovalError.cancelled)) }
        }
        guard settled, let address = AppKit.instance.getAddress() else { throw WalletApprovalError.cancelled }
        return address
    }

    /// `eth_signTypedData_v4` on Arc testnet; the wallet app opens to approve it.
    private func signTypedData(_ json: Data, from address: String) async throws -> String {
        guard let session = AppKit.instance.getSessions().first, let arc = Blockchain("eip155:\(Self.arcChainId)"),
              let typed = String(data: json, encoding: .utf8) else { throw WalletApprovalError.cancelled }
        let request = try Request(topic: session.topic, method: "eth_signTypedData_v4",
                                  params: AnyCodable(any: [address, typed]), chainId: arc, ttl: 300)
        let response: W3MResponse = try await withCheckedThrowingContinuation { continuation in
            var done = false
            var subs = Set<AnyCancellable>()
            func finish(_ r: Result<W3MResponse, Error>) {
                guard !done else { return }
                done = true
                subs.removeAll()
                continuation.resume(with: r)
            }
            AppKit.instance.sessionResponsePublisher.receive(on: DispatchQueue.main)
                .filter { $0.id == request.id }
                .sink { finish(.success($0)) }.store(in: &subs)
            DispatchQueue.main.asyncAfter(deadline: .now() + 300) { finish(.failure(WalletApprovalError.cancelled)) }
            Task { @MainActor in
                do {
                    try await AppKit.instance.request(params: request)
                    AppKit.instance.launchCurrentWallet()
                } catch {
                    finish(.failure(WalletApprovalError.refused("The wallet could not be asked to sign: \(error.localizedDescription)")))
                }
            }
        }
        switch response.result {
        case .response(let value):
            let signature = (try? value.get(String.self)) ?? ""
            guard signature.range(of: "^0x[0-9a-fA-F]{130}$", options: .regularExpression) != nil else {
                throw WalletApprovalError.refused("The wallet returned something that is not a signature. Nothing was sent.")
            }
            return signature
        case .error(let e):
            throw e.code == 4001 || e.code == 5000 ? WalletApprovalError.cancelled
                : WalletApprovalError.refused("The wallet refused: \(e.message)")
        }
    }

    // MARK: WalletApprovalPort

    func sign(_ request: SigningRequest, step: Int, typedDataJSON: Data, gesture: UserApprovalGesture) async throws -> String {
        guard UIApplication.shared.applicationState == .active, gesture.requestId == request.request.requestId,
              Date().timeIntervalSince(gesture.at) < 600, request.steps.indices.contains(step) else {
            throw WalletApprovalError.refused("Signing starts only from the approval screen.")
        }
        let address = try await connectedAddress()
        guard address.lowercased() == request.signerAddress.lowercased() else {
            throw WalletApprovalError.refused("The connected wallet \(shortId(address)) is not the wallet this request needs "
                                              + "(\(shortId(request.signerAddress))). Switch wallets in your wallet app.")
        }
        return try await signTypedData(typedDataJSON, from: address)
    }

    // MARK: WalletLoginPort

    /// Asks the server for a `WorkspaceLogin` challenge for this wallet (audience
    /// "native") and has the wallet sign it. It proves who you are; it approves nothing.
    func signLoginChallenge(host: String) async throws -> SignedLoginChallenge {
        let address = try await connectedAddress()
        var c = URLComponents()
        c.scheme = "https"
        c.host = host
        c.path = "/api/v2/auth/challenge"
        guard let url = c.url else { throw WalletApprovalError.notConfigured("Synq's host is not configured.") }
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "content-type")
        r.httpBody = try JSONSerialization.data(withJSONObject: ["wallet": address, "audience": "native"])
        let (data, response) = try await URLSession(configuration: .ephemeral).data(for: r)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let challengeId = body["challengeId"] as? String,
              let typed = body["typedData"] as? [String: Any] else {
            throw WalletApprovalError.refused("Synq could not start wallet sign-in.")
        }
        guard (typed["primaryType"] as? String) == "WorkspaceLogin" else {
            throw WalletApprovalError.refused("That sign-in message is not a Synq sign-in. Nothing was signed.")
        }
        let json = try JSONSerialization.data(withJSONObject: typed, options: [.sortedKeys])
        let signature = try await signTypedData(json, from: address)
        return SignedLoginChallenge(challengeId: challengeId, signature: signature)
    }
}

/// The SDK's crypto hook. Keccak-256 is used for address checksums; public key
/// recovery is only needed for one-click "sign in with Ethereum", which Synq does
/// not use, so it refuses.
struct SynqKeccakCrypto: CryptoProvider {
    struct Unsupported: Error {}
    func recoverPubKey(signature: EthereumSignature, message: Data) throws -> Data { throw Unsupported() }
    func keccak256(_ data: Data) -> Data { Keccak256.hash(data) }
}

/// Keccak-256 (the original Keccak padding Ethereum uses, not SHA3-256).
enum Keccak256 {
    private static let rc: [UInt64] = [
        0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B,
        0x0000000080000001, 0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088,
        0x0000000080008009, 0x000000008000000A, 0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
        0x8000000000008003, 0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
        0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
    ]
    private static let rotation: [Int] = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]

    private static func rotl(_ x: UInt64, _ n: Int) -> UInt64 { n == 0 ? x : (x << UInt64(n)) | (x >> UInt64(64 - n)) }

    private static func permute(_ a: inout [UInt64]) {
        for round in 0..<24 {
            var c = [UInt64](repeating: 0, count: 5)
            for x in 0..<5 { c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20] }
            for x in 0..<5 {
                let d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1)
                for y in stride(from: 0, to: 25, by: 5) { a[y + x] ^= d }
            }
            var b = [UInt64](repeating: 0, count: 25)
            for x in 0..<5 {
                for y in 0..<5 {
                    b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], rotation[x + 5 * y])
                }
            }
            for x in 0..<5 {
                for y in 0..<5 {
                    a[x + 5 * y] = b[x + 5 * y] ^ (~b[(x + 1) % 5 + 5 * y] & b[(x + 2) % 5 + 5 * y])
                }
            }
            a[0] ^= rc[round]
        }
    }

    static func hash(_ data: Data) -> Data {
        let rate = 136
        var message = [UInt8](data)
        message.append(0x01)
        while message.count % rate != 0 { message.append(0) }
        message[message.count - 1] |= 0x80
        var state = [UInt64](repeating: 0, count: 25)
        for blockStart in stride(from: 0, to: message.count, by: rate) {
            for i in 0..<(rate / 8) {
                var lane: UInt64 = 0
                for j in 0..<8 { lane |= UInt64(message[blockStart + i * 8 + j]) << UInt64(8 * j) }
                state[i] ^= lane
            }
            permute(&state)
        }
        var out = [UInt8]()
        for i in 0..<4 { for j in 0..<8 { out.append(UInt8((state[i] >> UInt64(8 * j)) & 0xFF)) } }
        return Data(out)
    }
}
