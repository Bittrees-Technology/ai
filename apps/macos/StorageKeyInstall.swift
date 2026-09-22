import Foundation
import Security

enum StorageKeyAddResult: Int32 { case created = 0, failed = 1, exists = 2 }
// No update/delete operation exists in this helper. Duplicate creation is atomic.
func addStorageKeyIfAbsent(profile: String, secret: Data) -> StorageKeyAddResult {
    guard profile.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil,
          secret.count == 32 else { return .failed }
    var keychain: SecKeychain?
    guard SecKeychainCopyDomainDefault(.user, &keychain) == errSecSuccess,
          let keychain = keychain else { return .failed }
    let attributes: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: "org.bittrees.ai.storage",
        kSecAttrAccount: profile,
        kSecValueData: secret,
        kSecUseKeychain: keychain
    ]
    let status = SecItemAdd(attributes as CFDictionary, nil)
    if status == errSecSuccess { return .created }
    if status == errSecDuplicateItem { return .exists }
    return .failed
}
