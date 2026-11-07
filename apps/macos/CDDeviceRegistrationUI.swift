import Cocoa

// This capability belongs only to the native shell. The ordinary launcher
// provides none until canonical native Roles authentication is available.
extension Companion {
    func cdDeviceControl() -> (URL, String)? {
        let env = ProcessInfo.processInfo.environment
        guard let endpoint = env["BITTREES_CD_DEVICE_CONTROL_URL"], let url = URL(string: endpoint),
              url.scheme == "http", url.host == "127.0.0.1",
              let port = url.port, (1...65535).contains(port),
              url.path == "/cd-device-registration-control",
              url.query == nil, url.fragment == nil, url.user == nil, url.password == nil,
              url.absoluteString == endpoint,
              let token = env["BITTREES_CD_DEVICE_CONTROL_TOKEN"],
              token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { return nil }
        return (url, token)
    }
    @objc func reviewCDDeviceRegistration() {
        guard !cdDeviceReviewBusy, let (url, token) = cdDeviceControl() else { return }
        cdDeviceReviewBusy = true
        _ = EnrollmentControlRequest(url: url, token: token, body: ["action": "propose"], timeout: 15) { [weak self] value in
            guard let self = self else { return }
            let keys: Set<String> = ["id", "requestDigest", "packetDigest", "expiresAt", "label",
                                     "principal", "credentialId", "deviceId", "ownerProfile", "purpose", "audience"]
            guard let value = value, Set(value.keys) == keys,
                  let id = value["id"] as? String, UUID(uuidString: id) != nil,
                  let requestDigest = value["requestDigest"] as? String,
                  let packetDigest = value["packetDigest"] as? String,
                  let fingerprint = value["credentialId"] as? String,
                  [requestDigest, packetDigest, fingerprint].allSatisfy({ $0.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil }),
                  let label = value["label"] as? String, !label.isEmpty, label.count <= 80,
                  label.rangeOfCharacter(from: .controlCharacters) == nil,
                  let principal = value["principal"] as? String,
                  principal.range(of: "^(agent|service):[a-f0-9-]{36}$", options: .regularExpression) != nil,
                  let device = value["deviceId"] as? String, UUID(uuidString: device) != nil,
                  let owner = value["ownerProfile"] as? String, UUID(uuidString: owner) != nil,
                  value["purpose"] as? String == "crypto-directory:read-access",
                  value["audience"] as? String == "https://roles.bittrees.org/api/profile/mcp/devices/register",
                  let expiry = value["expiresAt"] as? Double,
                  expiry > Date().timeIntervalSince1970 * 1000,
                  expiry <= Date().timeIntervalSince1970 * 1000 + 60000 else {
                self.cdDeviceReviewBusy = false
                _ = EnrollmentControlRequest(url: url, token: token, body: ["action": "revoke"]) { _ in }
                self.enrollmentNotice("CD device review unavailable", "A fresh authenticated Roles review is required.")
                return
            }
            let alert = NSAlert()
            alert.messageText = "Sign this CryptoDirectory device registration?"
            alert.informativeText = """
            Device: \(label)
            Device reference: \(device)
            Roles owner: \(owner)
            Actor: \(principal)
            Key fingerprint: \(fingerprint)
            Purpose: CryptoDirectory read access
            Destination: roles.bittrees.org
            Expires: \(Date(timeIntervalSince1970: expiry / 1000))

            This signs the displayed device registration request. Registration, source consent and access approval remain separate.
            """
            alert.addButton(withTitle: "Cancel")
            alert.addButton(withTitle: "Sign registration proof")
            alert.beginSheetModal(for: self.window) { response in
                let approve = response == .alertSecondButtonReturn && Date().timeIntervalSince1970 * 1000 < expiry
                let body: [String: Any] = approve
                    ? ["action": "approve", "id": id, "requestDigest": requestDigest,
                       "packetDigest": packetDigest, "confirmed": true]
                    : ["action": "revoke"]
                _ = EnrollmentControlRequest(url: url, token: token, body: body, timeout: 15) { result in
                    self.cdDeviceReviewBusy = false
                    if approve {
                        self.enrollmentNotice(result?["signed"] as? Bool == true ? "Registration proof signed" : "Signature held",
                                              "The local helper retains the exact proof. Device registration and access approval require their own confirmed steps.")
                    }
                }
            }
        }
    }
}
