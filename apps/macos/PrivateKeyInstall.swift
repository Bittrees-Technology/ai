import Foundation
import Security

// Immutable slots only. Attempts/deletion markers intentionally survive key removal.
func privateKeyService(kind: String) -> String? {
    switch kind {
    case "key": return "org.bittrees.ai.endpoint-keys"
    case "attempt": return "org.bittrees.ai.endpoint-key-attempts"
    case "deleted": return "org.bittrees.ai.endpoint-key-deletions"
    default: return nil
    }
}
func addPrivateKeyItem(kind: String, account: String, secret: Data) -> Int32 {
    guard let service = privateKeyService(kind: kind),
          account.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
          !secret.isEmpty, secret.count <= 4096 else { return 1 }
    var keychain: SecKeychain?
    guard SecKeychainCopyDomainDefault(.user, &keychain) == errSecSuccess,
          let keychain = keychain else { return 1 }
    let attributes: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword, kSecAttrService: service,
        kSecAttrAccount: account, kSecValueData: secret, kSecUseKeychain: keychain
    ]
    let status = SecItemAdd(attributes as CFDictionary, nil)
    if status == errSecSuccess { return 0 }
    if status == errSecDuplicateItem { return 2 }
    return 1
}
