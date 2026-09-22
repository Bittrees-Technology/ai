import Foundation
import Security

struct CheckFailed: Error {}
func require(_ value: Bool) throws { if !value { throw CheckFailed() } }
@main
struct KeyInstallTests {
    static func main() {
        // Process-local test setting: never display an unlock/access prompt.
        SecKeychainSetUserInteractionAllowed(false)
        let profile = "recovery-test-" + UUID().uuidString
        var keychain: SecKeychain?
        guard SecKeychainCopyDomainDefault(.user, &keychain) == errSecSuccess, let keychain = keychain else { print("Synthetic keychain unavailable"); exit(1) }
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: "org.bittrees.ai.storage", kSecAttrAccount: profile, kSecMatchSearchList: [keychain]]
        var created = false
        do {
            defer { if created { _ = SecItemDelete(query as CFDictionary) } }
            try require(SecItemCopyMatching(query as CFDictionary, nil) == errSecItemNotFound)
            try require(addStorageKeyIfAbsent(profile: profile, secret: Data(repeating: 1, count: 31)) == .failed)
            try require(SecItemCopyMatching(query as CFDictionary, nil) == errSecItemNotFound)
            try require(addStorageKeyIfAbsent(profile: profile, secret: Data(repeating: 7, count: 32)) == .created)
            created = true
            try require(addStorageKeyIfAbsent(profile: profile, secret: Data(repeating: 9, count: 32)) == .exists)
            var read = query
            read[kSecReturnData] = true
            var result: CFTypeRef?
            try require(SecItemCopyMatching(read as CFDictionary, &result) == errSecSuccess)
            try require((result as? Data) == Data(repeating: 7, count: 32))
            try require(SecItemDelete(query as CFDictionary) == errSecSuccess)
            created = false
            print("Synthetic add-only Keychain test passed; duplicate preserved original; test credential removed")
        } catch { print("Synthetic add-only Keychain test failed"); exit(1) }
    }
}
