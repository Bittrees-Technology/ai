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
    // The creator and its sibling bundled Node runtime are the two intended readers.
    // Do not grant all-app access or accept a caller-selected trusted executable.
    let nodePath = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        .deletingLastPathComponent().appendingPathComponent("node").path
    guard FileManager.default.isExecutableFile(atPath: nodePath) else { return 1 }
    var creator: SecTrustedApplication?
    var node: SecTrustedApplication?
    guard SecTrustedApplicationCreateFromPath(nil, &creator) == errSecSuccess,
          nodePath.withCString({ SecTrustedApplicationCreateFromPath($0, &node) }) == errSecSuccess,
          let creator = creator, let node = node else { return 1 }
    var access: SecAccess?
    guard SecAccessCreate("Bittrees AI private endpoint key" as CFString, [creator, node] as CFArray, &access) == errSecSuccess,
          let access = access else { return 1 }
    let attributes: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword, kSecAttrService: service,
        kSecAttrAccount: account, kSecValueData: secret, kSecUseKeychain: keychain,
        kSecAttrAccess: access
    ]
    let status = SecItemAdd(attributes as CFDictionary, nil)
    if status == errSecSuccess { return 0 }
    if status == errSecDuplicateItem { return 2 }
    return 1
}
