import Foundation
@main
struct KitRecoveryTests {
    static func reply(_ fields: [String: Any], _ exit: Bool = true) -> KitRecoveryReply {
        KitRecoveryReply(data: try! JSONSerialization.data(withJSONObject: fields), exitedNormally: exit)
    }
    static func main() {
        for status in ["created", "already-present"] {
            precondition(reply(["version": 1, "activated": true, "keyStatus": status]).succeeded)
            precondition(!reply(["version": 1, "activated": false, "keyStatus": status]).succeeded)
        }
        for status in ["conflict", "unconfirmed", "unknown"] {
            for activated in [true, false] { precondition(!reply(["version": 1, "activated": activated, "keyStatus": status]).succeeded) }
        }
        let success: [String: Any] = ["version": 1, "activated": true, "keyStatus": "created"]
        precondition(!reply(success, false).succeeded)
        for change in [["version": true], ["activated": 1], ["extra": "secret"]] as [[String: Any]] {
            var fields = success; fields.merge(change) { _, new in new }; precondition(!reply(fields).succeeded)
        }
        for error in ["RECOVERY_KIT_REJECTED", "EXISTING_KEY_CONFLICT", "CURRENT_DATA_KEY_CONFLICT", "BACKUP_RESTORE_FAILED", "RECOVERY_UNCONFIRMED", "private detail"] {
            let value = reply(["version": 1, "error": error], false)
            precondition(!value.succeeded && !value.message.contains("private detail"))
        }
        precondition(!KitRecoveryReply(data: Data(repeating: 0, count: 2049), exitedNormally: true).succeeded)
        precondition(!KitRecoveryReply(data: Data(), exitedNormally: true).succeeded)
        print("Native kit recovery: strict results, confirmed activation, conflict and uncertain outcomes passed")
    }
}
