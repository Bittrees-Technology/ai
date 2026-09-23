import Foundation
import Security

@main
struct PrivateKeyInstallMain {
    static func main() {
        guard CommandLine.arguments.count == 7,
              CommandLine.arguments[1] == "--operation",
              CommandLine.arguments[3] == "--kind",
              CommandLine.arguments[5] == "--account",
              privateKeyCallerAllowed() else { exit(1) }
        // A locked or untrusted key must fail, never wait for an unseen access prompt.
        SecKeychainSetUserInteractionAllowed(false)
        let operation = CommandLine.arguments[2], kind = CommandLine.arguments[4], account = CommandLine.arguments[6]
        if operation == "read" {
            var (status, secret) = readPrivateKeyItem(kind: kind, account: account)
            if var data = secret {
                defer { data.resetBytes(in: 0..<data.count); secret = nil }
                do { try FileHandle.standardOutput.write(contentsOf: data) } catch { exit(1) }
            }
            exit(status)
        }
        if operation == "delete" { exit(deletePrivateKeyItem(kind: kind, account: account)) }
        guard operation == "add" else { exit(1) }
        var secret = Data()
        do {
            while secret.count <= 4096 {
                guard let chunk = try FileHandle.standardInput.read(upToCount: 4097 - secret.count), !chunk.isEmpty else { break }
                secret.append(chunk)
            }
        } catch { secret.resetBytes(in: 0..<secret.count); exit(1) }
        let result = addPrivateKeyItem(kind: kind, account: account, secret: secret)
        secret.resetBytes(in: 0..<secret.count)
        exit(result)
    }
}
