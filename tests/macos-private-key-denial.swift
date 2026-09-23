import Foundation
import Security

// Disposable CI-only probe. It must see the test item's metadata but cannot read its bytes.
@main
struct PrivateKeyDenialProbe {
    static func main() {
        guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true",
              CommandLine.arguments.count == 3,
              CommandLine.arguments[1].range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { exit(1) }
        SecKeychainSetUserInteractionAllowed(false)
        let base: [CFString: Any] = [kSecClass: kSecClassGenericPassword,
            kSecAttrService: "org.bittrees.ai.endpoint-keys", kSecAttrAccount: CommandLine.arguments[1]]
        var metadata=base
        metadata[kSecReturnAttributes]=true
        var result: CFTypeRef?
        guard SecItemCopyMatching(metadata as CFDictionary, &result) == errSecSuccess else { exit(1) }
        result=nil
        var secret=base
        secret[kSecReturnData]=true
        let status=SecItemCopyMatching(secret as CFDictionary, &result)
        if var data=result as? Data { data.resetBytes(in: 0..<data.count) }
        guard status == errSecInteractionNotAllowed || status == errSecAuthFailed else { exit(1) }
        // The helper must also reject direct invocation by this unrelated parent.
        let child = Process(), output = Pipe()
        child.executableURL = URL(fileURLWithPath: CommandLine.arguments[2])
        child.arguments = ["--operation", "read", "--kind", "key", "--account", CommandLine.arguments[1]]
        child.standardOutput = output
        child.standardError = FileHandle.nullDevice
        do { try child.run(); child.waitUntilExit() } catch { exit(1) }
        let bytes = output.fileHandleForReading.readDataToEndOfFile()
        guard child.terminationStatus == 1, bytes.isEmpty else { exit(1) }
        print("UNTRUSTED_READ_DENIED")
    }
}
