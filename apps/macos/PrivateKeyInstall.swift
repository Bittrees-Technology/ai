import Foundation
import Security

func privateKeyService(kind: String) -> String? {
    switch kind {
    case "key": return "org.bittrees.ai.endpoint-keys"
    case "attempt": return "org.bittrees.ai.endpoint-key-attempts"
    case "deleted": return "org.bittrees.ai.endpoint-key-deletions"
    default: return nil
    }
}
// Only the sibling bundled runtime may invoke this pipe protocol. This is not a
// defense against a compromised local runtime or code running as the same user.
func privateKeyCallerAllowed() -> Bool {
    let node = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        .deletingLastPathComponent().appendingPathComponent("node").standardizedFileURL
    var parent: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: getppid()] as CFDictionary,
        SecCSFlags(rawValue: 0), &parent) == errSecSuccess, let parent = parent else { return false }
    var staticParent: SecStaticCode?
    guard SecCodeCopyStaticCode(parent, SecCSFlags(rawValue: 0), &staticParent) == errSecSuccess,
          let staticParent = staticParent else { return false }
    var path: CFURL?
    guard SecCodeCopyPath(staticParent, SecCSFlags(rawValue: 0), &path) == errSecSuccess,
          let path = path else { return false }
    return (path as URL).resolvingSymlinksInPath().standardizedFileURL == node
}
func privateKeyQuery(kind: String, account: String, adding: Bool = false) -> [CFString: Any]? {
    guard let service = privateKeyService(kind: kind),
          account.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { return nil }
    var keychain: SecKeychain?
    guard SecKeychainCopyDomainDefault(.user, &keychain) == errSecSuccess,
          let keychain = keychain else { return nil }
    var query: [CFString: Any] = [kSecClass: kSecClassGenericPassword,
        kSecAttrService: service, kSecAttrAccount: account]
    if adding { query[kSecUseKeychain] = keychain }
    else { query[kSecMatchSearchList] = [keychain] }
    return query
}
func addPrivateKeyItem(kind: String, account: String, secret: Data) -> Int32 {
    guard var attributes = privateKeyQuery(kind: kind, account: account, adding: true),
          !secret.isEmpty, secret.count <= 4096 else { return 1 }
    attributes[kSecValueData] = secret
    // Default Keychain access belongs to this helper. Reads use this same executable.
    let status = SecItemAdd(attributes as CFDictionary, nil)
    if status == errSecSuccess { return 0 }
    if status == errSecDuplicateItem { return 2 }
    return 1
}
func readPrivateKeyItem(kind: String, account: String) -> (Int32, Data?) {
    guard var query = privateKeyQuery(kind: kind, account: account) else { return (1, nil) }
    query[kSecReturnData] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return (2, nil) }
    guard status == errSecSuccess, let data = result as? Data,
          !data.isEmpty, data.count <= 4096 else { return (1, nil) }
    return (0, data)
}
func deletePrivateKeyItem(kind: String, account: String) -> Int32 {
    // Application deletion must retain attempt and deletion markers.
    guard kind == "key", let query = privateKeyQuery(kind: kind, account: account) else { return 1 }
    let status = SecItemDelete(query as CFDictionary)
    if status == errSecSuccess { return 0 }
    if status == errSecItemNotFound { return 2 }
    return 1
}
