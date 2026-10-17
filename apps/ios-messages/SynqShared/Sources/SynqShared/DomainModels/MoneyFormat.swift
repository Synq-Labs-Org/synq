import Foundation
import SynqContracts

/// Exact display of integer base units. Money is never parsed into a float:
/// the decimal point is placed by string arithmetic using the asset's decimals.
public enum SynqMoney {
    /// "40", "0.000001", "1234.5"; nil when `units` is not a non-negative integer string.
    public static func decimal(_ units: String, decimals: Int) -> String? {
        guard !units.isEmpty, units.count <= 78, units.allSatisfy({ $0.isASCII && $0.isNumber }),
              (0...36).contains(decimals) else { return nil }
        let digits = String(units.drop(while: { $0 == "0" }))
        guard decimals > 0 else { return digits.isEmpty ? "0" : digits }
        let padded = String(repeating: "0", count: max(0, decimals + 1 - digits.count)) + digits
        let cut = padded.index(padded.endIndex, offsetBy: -decimals)
        let whole = String(padded[..<cut])
        var fraction = String(padded[cut...])
        while fraction.last == "0" { fraction.removeLast() }
        return fraction.isEmpty ? whole : "\(whole).\(fraction)"
    }

    /// Groups the whole part ("12,345.67") without touching the digits.
    public static func grouped(_ decimal: String) -> String {
        let parts = decimal.split(separator: ".", maxSplits: 1).map(String.init)
        var whole = parts.first ?? "0"
        var out = ""
        while whole.count > 3 {
            out = "," + whole.suffix(3) + out
            whole = String(whole.dropLast(3))
        }
        out = whole + out
        return parts.count > 1 ? "\(out).\(parts[1])" : out
    }

    public static func text(_ units: String, decimals: Int, symbol: String) -> String {
        guard let d = decimal(units, decimals: decimals) else { return "Unknown amount" }
        return "\(grouped(d)) \(symbol)"
    }

    /// Whether a base-unit string is a positive amount.
    public static func isPositive(_ units: String) -> Bool {
        units.allSatisfy { $0.isASCII && $0.isNumber } && units.contains { $0 != "0" }
    }
}

extension Money {
    /// "40 USDC".
    public var text: String { SynqMoney.text(units, decimals: decimals, symbol: symbol) }
    /// "40" (grouped, exact), for the amount component.
    public var amountText: String { SynqMoney.decimal(units, decimals: decimals).map(SynqMoney.grouped) ?? "—" }
    public var network: String { SynqChains.name(chainId) }
}

extension Balance {
    public func text(_ units: String) -> String { SynqMoney.text(units, decimals: decimals, symbol: symbol) }
    public func amount(_ units: String) -> String { SynqMoney.decimal(units, decimals: decimals).map(SynqMoney.grouped) ?? "—" }
    public var network: String { SynqChains.name(chainId) }
}

/// Chains the app can name, and the only explorer hosts it will open for each.
/// A receipt whose explorer link does not belong to its chain is shown without a link.
public enum SynqChains {
    public static let arcTestnet = 5042002

    static let names: [Int: String] = [
        5042002: "Arc testnet", 10143: "Monad testnet", 11155111: "Sepolia", 84532: "Base Sepolia",
        31337: "Local devnet",
    ]

    static let explorers: [Int: Set<String>] = [
        5042002: ["testnet.arcscan.app", "explorer.testnet.arc.io"],
        10143: ["testnet.monadexplorer.com", "testnet.monadvision.com"],
        11155111: ["sepolia.etherscan.io"],
        84532: ["sepolia.basescan.org"],
    ]

    public static func name(_ chainId: Int) -> String { names[chainId] ?? "Chain \(chainId)" }

    public static func isTestnet(_ chainId: Int) -> Bool { names[chainId] != nil }

    /// The explorer URL if it is https, on an explorer for `chainId`, and names `txHash`.
    public static func explorerURL(_ raw: String?, chainId: Int, txHash: String) -> URL? {
        guard let raw, let url = URL(string: raw), url.scheme == "https", let host = url.host?.lowercased(),
              explorers[chainId]?.contains(host) == true,
              url.absoluteString.lowercased().contains(txHash.lowercased()) else { return nil }
        return url
    }
}
