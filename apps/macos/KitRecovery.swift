import Foundation

struct KitRecoveryReply {
    let succeeded: Bool
    let message: String
    init(data: Data, exitedNormally: Bool) {
        self = Self.parse(data: data, exitedNormally: exitedNormally) ?? Self(succeeded: false, message: "Recovery could not be confirmed. A key or recovered copy may have been saved. Do not assume nothing changed. Review Keychain access and your recovery materials before explicitly retrying. Existing credentials are never replaced.")
    }
    static let invalidInput = Self(succeeded: false, message: "Check the saved recovery code and selected backup/kit files, then try again. Recovery has not started.")
    private init(succeeded: Bool, message: String) { self.succeeded = succeeded; self.message = message }
    private struct Success: Decodable { let version: Int; let activated: Bool; let keyStatus: String }
    private struct Failure: Decodable { let version: Int; let error: String }
    private static func parse(data: Data, exitedNormally: Bool) -> Self? {
        guard data.count <= 2048, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if Set(object.keys) == Set(["version", "activated", "keyStatus"]), exitedNormally,
           let result = try? JSONDecoder().decode(Success.self, from: data), result.version == 1 {
            switch result.keyStatus {
            case "created", "already-present":
                return Self(succeeded: result.activated, message: result.activated
                    ? "The storage key is verified and your recovered task and memory copy is selected. Earlier data remains in place. Remote permissions must be approved again. Connections and models are not included in the backup."
                    : "The storage key is verified, but the recovered copy could not be selected. The verified copy was retained. Check available storage and the content selection before explicitly retrying.")
            case "conflict" where !result.activated:
                return Self(succeeded: false, message: "A different Keychain entry appeared during recovery. It was preserved, and the recovered copy was not selected. Resolve the conflict before retrying; do not delete credentials without checking their data.")
            case "unconfirmed" where !result.activated: return nil
            default: return nil
            }
        }
        if Set(object.keys) == Set(["version", "error"]),
           let result = try? JSONDecoder().decode(Failure.self, from: data), result.version == 1 {
            let messages = [
                "INVALID_PATH": "A selected file or recovery folder is unavailable. Check the backup and kit files, then retry.",
                "INVALID_ACTIVE_CONTENT": "The current content selection is invalid. Recovery stopped; the selection needs diagnosis before retrying.",
                "RECOVERY_KIT_REJECTED": "The kit or recovery code was rejected. Check that they belong together. No storage key was installed.",
                "KEY_STORE_UNAVAILABLE": "Keychain could not be read. Unlock or allow access, then explicitly retry. No storage key was installed.",
                "EXISTING_KEY_CONFLICT": "An existing storage key differs from this recovery kit. It was preserved. Use the matching kit or resolve the existing data and key before retrying.",
                "CURRENT_DATA_KEY_CONFLICT": "This kit does not match current data, or those stores could not be checked. Recovery stopped before key installation.",
                "BACKUP_RESTORE_FAILED": "The backup could not be validated with this kit. Check the matching backup and available storage. No storage key was installed.",
                "COMPANION_RUNNING_OR_PORT_UNAVAILABLE": "The local companion port is unavailable. Close the other companion or resolve the port conflict, then retry. No storage key was installed."
            ]
            if let message = messages[result.error] { return Self(succeeded: false, message: message) }
        }
        return nil
    }
}
