import Cocoa

extension Companion {
    func centralControl() -> (URL, String)? {
        let environment = ProcessInfo.processInfo.environment
        guard let endpoint = environment["BITTREES_CENTRAL_CONTROL_URL"], let url = URL(string: endpoint),
              url.scheme == "http", url.host == "127.0.0.1", let port = url.port, port > 0, port <= 65535,
              url.path == "/central-workflow-control", url.query == nil, url.fragment == nil, url.user == nil, url.password == nil,
              url.absoluteString == endpoint, let token = environment["BITTREES_CENTRAL_CONTROL_TOKEN"],
              token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { return nil }
        return (url, token)
    }
    @objc func reviewCentralWorkflow() {
        guard !centralReviewBusy, let (url, token) = centralControl() else { return }
        centralReviewBusy = true
        _ = EnrollmentControlRequest(url: url, token: token, body: ["action": "propose"]) { [weak self] proposal in
            guard let self = self else { return }
            guard let proposal = proposal, let display = CentralReviewDisplay.parse(proposal) else {
                self.centralReviewBusy = false
                self.enrollmentNotice("Workflow review is unavailable", "The native helper did not provide a valid current scope and budget. Nothing was approved.")
                return
            }
            let digest = display.digest, expiry = display.expiresAt
            let maximum = String(format: "$%.6f", Double(display.maximumMicroUSD) / 1000000)
            let attempt = String(format: "$%.6f", Double(display.attemptCeilingMicroUSD) / 1000000)
            let deadline = Date(timeIntervalSince1970: expiry / 1000).formatted(date: .abbreviated, time: .standard)
            let alert = NSAlert()
            alert.messageText = "Allow bounded workflow verification?"
            alert.informativeText = "Workflow: \(display.workflow)\nWorkspace: \(display.workspace) · Tenant: \(display.tenant)\nWallet: \(display.wallet)\nDevice agent: \(display.principal)\nDevice key: \(display.keyDigest)\nDelegation: \(display.delegation)\nSource connection: \(display.connection)\n\nSend this workflow's instructions, signed device requests and model results through mcp.bittrees.org to the existing Workflows service. Only claim, renew and complete are allowed, with current Roles and source authorization for each action.\n\nAt most \(display.maximumAttempts) attempts until \(deadline). Additional spending limit: \(maximum). Each attempt reserves up to \(attempt) across downstream services, including failures. Cost evidence: \(display.evidence).\n\nThis approval expires. Standing delegation and source permissions require their separate wallet/controller approvals."
            alert.addButton(withTitle: "Cancel")
            alert.addButton(withTitle: "Allow reviewed requests")
            alert.beginSheetModal(for: self.window) { response in
                let approving = response == .alertSecondButtonReturn && Date().timeIntervalSince1970 * 1000 < expiry
                let body: [String: Any] = approving ? ["action": "approve", "digest": digest] : ["action": "revoke"]
                _ = EnrollmentControlRequest(url: url, token: token, body: body) { result in
                    self.centralReviewBusy = false
                    if approving {
                        let approved = result?["approved"] as? Bool == true
                        self.enrollmentNotice(approved ? "Reviewed requests allowed" : "Approval was not confirmed", approved ? "The native helper may carry the reviewed workflow requests within their deadline and budget. Roles and source permissions still apply." : "The scope, deadline or admission may have changed. Review again before continuing.")
                    }
                }
            }
        }
    }
    @objc func stopCentralWorkflow() {
        guard !centralReviewBusy, let (url, token) = centralControl() else { return }
        centralReviewBusy = true
        _ = EnrollmentControlRequest(url: url, token: token, body: ["action": "revoke"]) { [weak self] result in
            guard let self = self else { return }
            self.centralReviewBusy = false
            let revoked = result?["revoked"] as? Bool == true
            self.enrollmentNotice(revoked ? "Workflow verification stopped" : "Stop was not confirmed", revoked ? "New requests require a fresh native review. Requests with uncertain source outcomes must be reconciled before retrying." : "The helper did not confirm revocation. The previous approval may remain active until its deadline. Check the connection before continuing.")
        }
    }
}
