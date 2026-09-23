import Foundation

@main
struct PrivateKeyInstallMain {
    static func main() {
        guard CommandLine.arguments.count == 5,
              CommandLine.arguments[1] == "--kind",
              CommandLine.arguments[3] == "--account" else { exit(1) }
        var secret = Data()
        do {
            while secret.count <= 4096 {
                guard let chunk = try FileHandle.standardInput.read(upToCount: 4097 - secret.count), !chunk.isEmpty else { break }
                secret.append(chunk)
            }
        } catch { secret.resetBytes(in: 0..<secret.count); exit(1) }
        let result = addPrivateKeyItem(kind: CommandLine.arguments[2], account: CommandLine.arguments[4], secret: secret)
        secret.resetBytes(in: 0..<secret.count)
        exit(result)
    }
}
