import Foundation
import SynqContracts

/// Checks an approval's typed data before a wallet is asked to sign it, and
/// extracts the exact `typedData` of each signing step for the wallet. It
/// refuses when: an integer field arrives as a JSON number (precision may
/// already be lost), a step's domain chain is not the chain of the amount, the
/// request has expired, the expected signer is not a full address, or the bytes
/// are not the typed data the screen shows.
public enum TypedDataGuard {
    public struct Step: Equatable, Sendable {
        public let label: String
        /// The step's `typedData` taken from the server's JSON (keys sorted, numbers untouched).
        public let json: Data
    }

    public struct Prepared: Equatable, Sendable {
        /// In the order the server requires them to be signed.
        public let steps: [Step]
        public let problems: [String]
        public var canSign: Bool { problems.isEmpty && !steps.isEmpty }
    }

    public static func prepare(responseBody: Data, request: SigningRequest, now: Date = Date()) -> Prepared {
        var problems: [String] = []
        guard let root = try? JSONSerialization.jsonObject(with: responseBody, options: [.fragmentsAllowed]) as? [String: Any],
              let rawSteps = root["steps"] as? [[String: Any]], !rawSteps.isEmpty,
              rawSteps.count == request.steps.count else {
            return Prepared(steps: [], problems: ["The approval did not include anything to sign."])
        }
        if request.signerAddress.range(of: "^0x[0-9a-fA-F]{40}$", options: .regularExpression) == nil {
            problems.append("The request does not name the wallet that must sign.")
        }
        if let e = request.request.expiresAt, let expires = SynqTime.parse(e), expires <= now {
            problems.append("This request expired \(SynqTime.short(e)).")
        }
        var steps: [Step] = []
        for (i, raw) in rawSteps.enumerated() {
            let n = rawSteps.count > 1 ? "Step \(i + 1): " : ""
            guard let typed = raw["typedData"] as? [String: Any],
                  let json = try? JSONSerialization.data(withJSONObject: typed, options: [.sortedKeys]) else {
                problems.append("\(n)no typed data.")
                continue
            }
            let types = typed["types"] as? [String: [[String: Any]]] ?? [:]
            let primary = typed["primaryType"] as? String ?? ""
            if types[primary] == nil { problems.append("\(n)the typed data does not define its primary type.") }
            if let message = typed["message"] as? [String: Any] {
                problems += numericProblems(message, typeName: primary, types: types, path: "message").map { n + $0 }
            } else {
                problems.append("\(n)the typed data has no message.")
            }
            if let domain = typed["domain"] as? [String: Any] {
                if let chain = domain["chainId"] {
                    let id = (chain as? NSNumber)?.intValue ?? Int(chain as? String ?? "")
                    if let amountChain = request.request.amount?.chainId, let id, id != amountChain {
                        problems.append("\(n)the signature is for chain \(id) but the amount is on chain \(amountChain).")
                    }
                }
            } else {
                problems.append("\(n)the typed data has no domain.")
            }
            // The decoded model and the bytes must describe the same typed data.
            if let decoded = try? JSONDecoder().decode(TypedData.self, from: json), decoded != request.steps[i].typedData {
                problems.append("\(n)the typed data changed while it was read.")
            }
            steps.append(Step(label: request.steps[i].label, json: json))
        }
        return Prepared(steps: steps, problems: problems)
    }

    /// Integer-typed fields must be decimal strings; nested structs are checked too.
    static func numericProblems(_ value: [String: Any], typeName: String, types: [String: [[String: Any]]],
                                path: String) -> [String] {
        guard let fields = types[typeName] else { return [] }
        var out: [String] = []
        for f in fields {
            guard let name = f["name"] as? String, let type = f["type"] as? String, let v = value[name] else { continue }
            let base = type.hasSuffix("[]") ? String(type.dropLast(2)) : type
            let values: [Any] = type.hasSuffix("[]") ? (v as? [Any] ?? []) : [v]
            for item in values {
                if base.hasPrefix("uint") || base.hasPrefix("int") {
                    if !(item is String) { out.append("\(path).\(name) is a number; it must be sent as a decimal string.") }
                } else if let nested = item as? [String: Any], types[base] != nil {
                    out += numericProblems(nested, typeName: base, types: types, path: "\(path).\(name)")
                }
            }
        }
        return out
    }

    /// The domain and message fields as label/value lines for the approval screen.
    public static func lines(_ typed: TypedData) -> [(String, String)] {
        var out: [(String, String)] = []
        for key in ["name", "version", "chainId", "verifyingContract", "salt"] {
            if let v = typed.domain[key] { out.append(("domain.\(key)", text(v))) }
        }
        for field in typed.types[typed.primaryType] ?? [] {
            if let v = typed.message[field.name] { out.append(("\(field.name) (\(field.type))", text(v))) }
        }
        return out
    }

    static func text(_ v: JSONValue) -> String {
        switch v {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() && abs(n) < 1e15 ? String(Int64(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "null"
        case .array(let a): return "[" + a.map(text).joined(separator: ", ") + "]"
        case .object(let o): return "{" + o.keys.sorted().map { "\($0): \(text(o[$0]!))" }.joined(separator: ", ") + "}"
        }
    }
}

extension ApprovalPurpose {
    /// An explicit label for what a signature does, so a sign-in is never mistaken for it.
    public var label: String {
        switch self {
        case .vaultSetup: return "Set up the vault"
        case .vaultAction: return "Vault action"
        case .payout: return "Approve a payment"
        case .financeChange: return "Change finance settings"
        case .revenuePolicy: return "Revenue split policy"
        case .dealTerms: return "Sign deal terms"
        case .escrow: return "Escrow funding or release"
        case .leaseIssue: return "Give an agent a spending lease"
        case .leaseRevoke: return "Revoke an agent lease"
        case .circleRefund: return "Circle refund"
        case .commercialPolicy: return "Approve a sales policy"
        case .unknown: return "Unknown request"
        }
    }

    /// Moves or authorises money (as opposed to a setting or a signature on terms).
    public var movesMoney: Bool {
        switch self {
        case .payout, .escrow, .leaseIssue, .circleRefund, .vaultAction: return true
        default: return false
        }
    }
}
