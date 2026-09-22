import Foundation

@main
struct KeyInstallMain {
    static func main() {
        guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--profile" else { exit(1) }
        var secret = Data()
        do {
            while secret.count <= 32 {
                guard let chunk = try FileHandle.standardInput.read(upToCount: 33 - secret.count), !chunk.isEmpty else { break }
                secret.append(chunk)
            }
        } catch { secret.resetBytes(in: 0..<secret.count); exit(1) }
        let result = addStorageKeyIfAbsent(profile: CommandLine.arguments[2], secret: secret)
        secret.resetBytes(in: 0..<secret.count)
        exit(result.rawValue)
    }
}
