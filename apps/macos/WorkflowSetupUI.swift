import Cocoa
import CryptoKit

extension Companion {
    func centralIdentityControl() -> (URL, String)? {
        let env = ProcessInfo.processInfo.environment
        guard let endpoint = env["BITTREES_CENTRAL_IDENTITY_URL"], let url = URL(string: endpoint),
              url.scheme == "http", url.host == "127.0.0.1", let port = url.port, port > 0, port <= 65535,
              url.path == "/enrollment-control", url.query == nil, url.fragment == nil, url.user == nil, url.password == nil,
              url.absoluteString == endpoint, let token = env["BITTREES_CENTRAL_IDENTITY_TOKEN"],
              token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { return nil }
        return (url, token)
    }
    @objc func reviewCentralIdentity() {
        guard !workflowIdentityReviewBusy, let (url, token) = centralIdentityControl() else { return }
        workflowIdentityReviewBusy = true
        let alert = NSAlert()
        alert.messageText = "Review this Mac’s central Workflows identity?"
        alert.informativeText = "Inspect the existing central Workflows identity on this Mac. No Roles profile ID is needed. This reads public identity information only; it creates no keys, enrolls no device, grants no permissions and makes no network requests."
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Review existing identity")
        alert.beginSheetModal(for: window) { response in
            guard response == .alertSecondButtonReturn else { self.workflowIdentityReviewBusy = false; return }
            _ = EnrollmentControlRequest(url: url, token: token, body: ["action":"propose"]) { result in
                self.workflowIdentityReviewBusy = false
                guard let r = result, Set(r.keys) == Set(["version","purpose","target","status","principal","publicKey","credentialId","rolesEnrollment","permissionsGranted","checkedAt","expiresAt"]),
                      r["version"] as? Int == 1, r["purpose"] as? String == "central-workflows", r["target"] as? String == "Bittrees Workflows on this Mac",
                      r["rolesEnrollment"] as? String == "unverified", r["permissionsGranted"] as? Bool == false,
                      let at = r["checkedAt"] as? Double, let end = r["expiresAt"] as? Double,
                      at <= Date().timeIntervalSince1970 * 1000 + 1000, end > Date().timeIntervalSince1970 * 1000, end - at == 60000 else {
                    self.enrollmentNotice("Central identity review unavailable", "The saved central identity could not be verified. No keys, data or permissions were changed.")
                    return
                }
                if r["status"] as? String == "missing", r["principal"] is NSNull, r["publicKey"] is NSNull, r["credentialId"] is NSNull {
                    self.enrollmentNotice("No central Workflows identity is saved", "No key was created. The CRM task-sync identity is separate and was not used. Creating a central identity and enrolling it in Roles require separate approval. This review grants no permissions.")
                    return
                }
                guard r["status"] as? String == "existing", let principal = r["principal"] as? String,
                      principal.hasPrefix("agent:"), UUID(uuidString: String(principal.dropFirst(6))) != nil,
                      let key = r["publicKey"] as? String, key.utf8.count <= 512, let fingerprint = r["credentialId"] as? String,
                      fingerprint == SHA256.hash(data: Data(key.utf8)).map({String(format:"%02x",$0)}).joined() else {
                    self.enrollmentNotice("Central identity review unavailable", "The saved public identity did not match its fingerprint. Nothing was changed.")
                    return
                }
                self.enrollmentNotice("Bittrees Workflows on this Mac", "Existing principal: \(principal)\nDevice key fingerprint: \(fingerprint)\n\nRoles enrollment is unverified. No permissions were granted. This central identity is separate from CRM task synchronization.")
            }
        }
    }
    func workflowSetupControl() -> (URL, String)? {
        let env = ProcessInfo.processInfo.environment
        guard let endpoint = env["BITTREES_WORKFLOW_SETUP_URL"], let url = URL(string: endpoint),
              url.scheme == "http", url.host == "127.0.0.1", let port = url.port, port > 0, port <= 65535,
              url.path == "/enrollment-control", url.query == nil, url.fragment == nil, url.user == nil, url.password == nil,
              url.absoluteString == endpoint, let token = env["BITTREES_WORKFLOW_SETUP_TOKEN"],
              token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { return nil }
        return (url, token)
    }
    @objc func reviewWorkflowIdentity() {
        guard !workflowIdentityReviewBusy, let (url, token) = workflowSetupControl() else { return }
        workflowIdentityReviewBusy = true
        let alert = NSAlert()
        alert.messageText = "Review this Mac’s workflow identity?"
        alert.informativeText = "Unlock the existing local workflow identity for inspection. This reads its public device binding only. It makes no network requests, creates no keys, and grants no Roles or workflow permissions."
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Review existing identity")
        alert.beginSheetModal(for: window) { response in
            guard response == .alertSecondButtonReturn else { self.workflowIdentityReviewBusy = false; return }
            _ = EnrollmentControlRequest(url: url, token: token, body: ["action": "propose"]) { result in
                self.workflowIdentityReviewBusy = false
                guard let result = result, Set(result.keys) == Set(["version","target","status","principal","publicKey","credentialId","sourceWorkspace","rolesEnrollment","controllerAssociation","grantsAuthority","checkedAt","expiresAt","reviewDigest"]),
                      result["version"] as? Int == 1, result["target"] as? String == "Bittrees local AI on this Mac",
                      result["rolesEnrollment"] as? String == "unverified", result["controllerAssociation"] as? String == "unverified",
                      result["grantsAuthority"] as? Bool == false,
                      let at = result["checkedAt"] as? Double, let end = result["expiresAt"] as? Double,
                      let reviewDigest = result["reviewDigest"] as? String,
                      reviewDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                      at <= Date().timeIntervalSince1970 * 1000 + 1000, end > Date().timeIntervalSince1970 * 1000, end - at == 60000 else {
                    self.enrollmentNotice("Identity review unavailable", "The existing local identity could not be verified. No keys or permissions were changed.")
                    return
                }
                if result["status"] as? String == "missing", result["principal"] is NSNull,
                   result["publicKey"] is NSNull, result["credentialId"] is NSNull, result["sourceWorkspace"] is NSNull {
                    let initialize = NSAlert()
                    initialize.messageText = "Create a local workflow identity?"
                    initialize.informativeText = "No existing task workflow key was found. Create an encrypted device key for Bittrees local AI on this Mac. This creates a local identity only; it does not enroll a credential in Roles, assign a public Agent controller, replace another local identity, or grant permissions. Authenticated Roles enrollment remains separate."
                    initialize.addButton(withTitle: "Cancel")
                    initialize.addButton(withTitle: "Create local identity")
                    self.workflowIdentityReviewBusy = true
                    initialize.beginSheetModal(for: self.window) { response in
                        let approved = response == .alertSecondButtonReturn && Date().timeIntervalSince1970 * 1000 < end
                        let body: [String: Any] = approved ? ["action":"approve","digest":reviewDigest] : ["action":"revoke"]
                        _ = EnrollmentControlRequest(url: url, token: token, body: body) { created in
                            self.workflowIdentityReviewBusy = false
                            if approved {
                                self.enrollmentNotice(created?["approved"] as? Bool == true ? "Local identity created" : "Identity creation was not confirmed", created?["approved"] as? Bool == true ? "The encrypted local key is saved. Review workflow identity again to inspect its public fingerprint. Roles enrollment and delegation still require an authenticated active person with current applicable roles." : "Inspect the saved identity before retrying. No Roles enrollment or workflow permission was granted.")
                            }
                        }
                    }
                    return
                }
                guard result["status"] as? String == "existing", let principal = result["principal"] as? String,
                      principal.hasPrefix("agent:"), UUID(uuidString: String(principal.dropFirst(6))) != nil,
                      let key = result["publicKey"] as? String, key.utf8.count <= 1024,
                      let digest = result["credentialId"] as? String,
                      digest == SHA256.hash(data: Data(key.utf8)).map({String(format:"%02x",$0)}).joined() else {
                    self.enrollmentNotice("Identity review unavailable", "The saved public identity did not match its fingerprint. Nothing was changed.")
                    return
                }
                self.workflowOnboarding?.recordLocalIdentity(principal: principal, fingerprint: digest)
                self.enrollmentNotice("Bittrees local AI on this Mac", "Existing principal: \(principal)\nDevice key fingerprint: \(digest)\n\nRoles enrollment and Agent controller association are unverified. Only an active person with current applicable Roles may approve delegation. This review grants no authority.")
            }
        }
    }
}
