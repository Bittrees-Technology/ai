import Foundation

struct Failure: Error {}
func check(_ condition: Bool) throws { if !condition { throw Failure() } }
@main
struct RecoverySetupTests {
    static func main() throws {
        var kit = Data("BTKEY01\n".utf8); kit.append(Data(repeating: 7, count: 108))
        let code = "btr1_" + Data(repeating: 3, count: 32).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let payload: [String: Any] = ["version": 1, "kitBase64": kit.base64EncodedString(), "recoveryCode": code, "kitId": String(repeating: "07", count: 16)]
        let data = try JSONSerialization.data(withJSONObject: payload)
        let session = try RecoverySetupSession(response: data)
        try check(session.displayedCode() == code)
        do { _ = try session.verifiedKit(); throw Failure() } catch RecoverySetupError.notVerified { }
        try check(!session.verify(code))
        session.acknowledgeSaved(); try check(session.displayedCode() == nil)
        try check(!session.verify("wrong")); try check(session.verify(code))
        try check(try session.verifiedKit() == kit)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("bittrees-setup-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("kit.btkey")
        try saveRecoveryKit(session.verifiedKit(), to: file)
        try check(try Data(contentsOf: file) == kit)
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        try check((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        do { try saveRecoveryKit(Data(repeating: 9, count: 116), to: file); throw Failure() } catch let error where !(error is Failure) { }
        try check(try Data(contentsOf: file) == kit)
        let symlink = root.appendingPathComponent("linked.btkey")
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: file)
        do { try saveRecoveryKit(kit, to: symlink); throw Failure() } catch let error where !(error is Failure) { }
        try check(try Data(contentsOf: file) == kit)
        try check(try FileManager.default.contentsOfDirectory(atPath: root.path).sorted() == ["kit.btkey", "linked.btkey"])
        session.clear(); try check(session.phase == .finished && session.displayedCode() == nil)
        let failures = try RecoverySetupSession(response: data); failures.acknowledgeSaved()
        for _ in 0..<3 { try check(!failures.verify("wrong")) }
        try check(failures.phase == .finished); try check(!failures.verify(code))
        for fields in [["version": true], ["extra": "ignored"], ["kitId": String(repeating: "00", count: 16)], ["recoveryCode": code + "="]] as [[String: Any]] {
            var invalid = payload; invalid.merge(fields) { _, new in new }
            do { _ = try RecoverySetupSession(response: JSONSerialization.data(withJSONObject: invalid)); throw Failure() } catch let error where !(error is Failure) { }
        }
        do { _ = try RecoverySetupSession(response: Data(repeating: 1, count: 2049)); throw Failure() } catch let error where !(error is Failure) { }
        print("Native kit setup: confirmation, attempt limit, strict IPC, private no-overwrite save and cleanup passed")
    }
}
