import Foundation
import Security

/// One generic-password Keychain item, readable only on this device after first
/// unlock. Sessions live here and nowhere else (never UserDefaults, never an
/// App Group). Items are not synchronised to iCloud Keychain.
public struct KeychainItem: Sendable {
    public let service: String
    public let account: String

    public init(service: String, account: String) {
        self.service = service
        self.account = account
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: false]
    }

    public func read() -> Data? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    public func write(_ data: Data) throws {
        var q = query
        SecItemDelete(q as CFDictionary)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func delete() {
        SecItemDelete(query as CFDictionary)
    }
}

public struct KeychainError: Error, Equatable, Sendable {
    public let status: OSStatus
    public var message: String { "Could not save securely on this iPhone (\(status)). Unlock the phone and try again." }
}

/// Where a store keeps its secrets. Production uses the Keychain; tests swap in
/// memory so they never touch the login keychain.
public protocol SecretStore: AnyObject, Sendable {
    func read(_ account: String) -> Data?
    func write(_ data: Data, _ account: String) throws
    func delete(_ account: String)
}

public final class KeychainSecretStore: SecretStore, @unchecked Sendable {
    public let service: String
    public init(service: String) { self.service = service }
    public func read(_ account: String) -> Data? { KeychainItem(service: service, account: account).read() }
    public func write(_ data: Data, _ account: String) throws { try KeychainItem(service: service, account: account).write(data) }
    public func delete(_ account: String) { KeychainItem(service: service, account: account).delete() }
}

public final class MemorySecretStore: SecretStore, @unchecked Sendable {
    private var items: [String: Data] = [:]
    private let lock = NSLock()
    public init() {}
    public func read(_ account: String) -> Data? { lock.lock(); defer { lock.unlock() }; return items[account] }
    public func write(_ data: Data, _ account: String) throws { lock.lock(); items[account] = data; lock.unlock() }
    public func delete(_ account: String) { lock.lock(); items[account] = nil; lock.unlock() }
    public var isEmpty: Bool { lock.lock(); defer { lock.unlock() }; return items.isEmpty }
    public var accounts: [String] { lock.lock(); defer { lock.unlock() }; return items.keys.sorted() }
}
