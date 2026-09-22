import Foundation

enum RecoverySetupError: Error { case invalid, notVerified }
final class RecoverySetupSession {
    enum Phase { case showingCode, verifying, saving, finished }
    private(set) var phase: Phase = .showingCode
    private(set) var attempts = 0
    private var code: String
    private var kit: Data
    private struct Payload: Decodable { let version: Int; let kitBase64: String; let recoveryCode: String; let kitId: String }
    init(response: Data) throws {
        guard response.count <= 2048,
              let fields = try JSONSerialization.jsonObject(with: response) as? [String: Any],
              Set(fields.keys) == Set(["version", "kitBase64", "recoveryCode", "kitId"]) else { throw RecoverySetupError.invalid }
        let payload = try JSONDecoder().decode(Payload.self, from: response)
        guard payload.version == 1, payload.recoveryCode.count == 48,
              payload.recoveryCode.range(of: "^btr1_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let bytes = Data(base64Encoded: payload.kitBase64), bytes.count == 116,
              bytes.base64EncodedString() == payload.kitBase64,
              bytes.prefix(8) == Data("BTKEY01\n".utf8),
              bytes[8..<24].map({ String(format: "%02x", $0) }).joined() == payload.kitId else { throw RecoverySetupError.invalid }
        let encodedCode = String(payload.recoveryCode.dropFirst(5))
        guard let codeBytes = Data(base64Encoded: encodedCode.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "="), codeBytes.count == 32,
              codeBytes.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == encodedCode else { throw RecoverySetupError.invalid }
        code = payload.recoveryCode
        kit = bytes
    }
    func displayedCode() -> String? { phase == .showingCode ? code : nil }
    func acknowledgeSaved() { if phase == .showingCode { phase = .verifying } }
    func verify(_ saved: String) -> Bool {
        guard phase == .verifying else { return false }
        if saved.trimmingCharacters(in: .whitespacesAndNewlines) == code { phase = .saving; return true }
        attempts += 1
        if attempts >= 3 { clear() }
        return false
    }
    func verifiedKit() throws -> Data {
        guard phase == .saving else { throw RecoverySetupError.notVerified }
        return kit
    }
    func clear() { code = ""; kit.resetBytes(in: 0..<kit.count); kit.removeAll(); phase = .finished }
    deinit { clear() }
}
// Publish only a complete private encrypted kit; existing destinations are never replaced.
func saveRecoveryKit(_ bytes: Data, to destination: URL) throws {
    guard destination.isFileURL, bytes.count == 116 else { throw RecoverySetupError.invalid }
    let manager = FileManager.default
    let temporary = destination.deletingLastPathComponent().appendingPathComponent(".bittrees-recovery-" + UUID().uuidString, isDirectory: true)
    try manager.createDirectory(at: temporary, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? manager.removeItem(at: temporary) }
    let staged = temporary.appendingPathComponent("kit")
    guard manager.createFile(atPath: staged.path, contents: bytes, attributes: [.posixPermissions: 0o600]) else { throw RecoverySetupError.invalid }
    let handle = try FileHandle(forWritingTo: staged)
    do { try handle.synchronize(); try handle.close() }
    catch { try? handle.close(); throw error }
    try manager.linkItem(at: staged, to: destination)
}
