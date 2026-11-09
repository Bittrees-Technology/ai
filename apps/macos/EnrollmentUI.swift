import Cocoa
import CryptoKit

// This capability stays in the native shell; startEngine's allowlist never forwards it.
final class EnrollmentControlRequest: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
    private var session: URLSession?
    private var bytes = Data()
    private var finished = false
    private let completion: ([String: Any]?) -> Void
    init(url: URL, token: String, body: [String: Any], timeout: TimeInterval = 5, completion: @escaping ([String: Any]?) -> Void) {
        self.completion = completion
        super.init()
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout + 1
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        session?.dataTask(with: request).resume()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              response.value(forHTTPHeaderField: "Content-Type") == "application/json",
              response.value(forHTTPHeaderField: "Content-Encoding") == nil else { completionHandler(.cancel); return }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if bytes.count + data.count > 16384 { dataTask.cancel(); return }
        bytes.append(data)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !finished else { return }
        finished = true
        let value = error == nil ? (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] : nil
        session.invalidateAndCancel()
        self.session = nil
        DispatchQueue.main.async { self.completion(value) }
    }
}

extension Companion {
    func enrollmentControl() -> (URL, String)? {
        let environment = ProcessInfo.processInfo.environment
        guard let endpoint = environment["BITTREES_ENROLLMENT_CONTROL_URL"], let url = URL(string: endpoint),
              url.scheme == "http", url.host == "127.0.0.1", let port = url.port, port > 0, port <= 65535,
              url.path == "/enrollment-control", url.query == nil, url.fragment == nil, url.user == nil, url.password == nil,
              url.absoluteString == endpoint,
              let token = environment["BITTREES_ENROLLMENT_CONTROL_TOKEN"],
              token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { return nil }
        return (url, token)
    }
    @objc func openWorkflowSetup() {
        guard ready, !quitting, window.attachedSheet == nil,
              !recovery.busy, !kitRecoveryChoosing, kitSetupId == nil,
              var destination = URLComponents(url: home, resolvingAgainstBaseURL: false) else { return }
        destination.queryItems = [URLQueryItem(name: "workflow-setup", value: nil)]
        guard let url = destination.url, local(url) else { return }
        web.load(URLRequest(url: url))
        window.makeKeyAndOrderFront(nil)
    }

    @objc func reviewEnrollment() { presentEnrollmentReview(onResult: nil) }

    func presentEnrollmentReview(onResult: ((Bool, String?) -> Void)?) {
        guard !enrollmentReviewBusy, window.attachedSheet == nil,
              let (url, token) = enrollmentControl() else {
            onResult?(false, "Close other reviews and try again.")
            return
        }
        enrollmentReviewBusy = true
        _ = EnrollmentControlRequest(url: url, token: token, body: ["action": "propose"]) { [weak self] proposal in
            guard let self = self else {
                onResult?(false, "The enrollment window closed.")
                return
            }
            guard !self.quitting, self.window.attachedSheet == nil else {
                self.enrollmentReviewBusy = false
                onResult?(false, "Close other reviews and try again.")
                return
            }
            guard let proposal = proposal, let display = EnrollmentReviewDisplay.parse(proposal) else {
                self.enrollmentReviewBusy = false
                if let onResult {
                    onResult(false, "The local setup has expired or is unavailable.")
                } else {
                    self.enrollmentNotice("Enrollment review is unavailable", "The local helper could not provide a valid, current review.")
                }
                return
            }
            let digest = display.digest, wallet = display.wallet, device = display.device
            let workspace = display.workspace, authority = display.authority, principal = display.principal
            let publicKey = display.publicKey, expiry = display.expiresAt
            let alert = NSAlert()
            alert.messageText = "Connect this Mac to Workflows?"
            alert.informativeText = "\(display.identityPurpose)\n\nWallet: \(wallet)\nMac: \(device)\nWorkspace: \(workspace)\nAuthority: \(authority)\nAgent: \(principal)\nDevice key: \(SHA256.hash(data: Data(publicKey.utf8)).map({ String(format: "%02x", $0) }).joined())\n\nContact ai.bittrees.org and roles.bittrees.org for up to five minutes, with at most 108 requests. \(display.spendingSummary)\n\nThis permits the enrollment request only. Roles approval and workflow authority remain separate."
            alert.addButton(withTitle: "Cancel")
            alert.addButton(withTitle: onResult == nil ? "Allow enrollment request" : "Request review in Roles")
            alert.beginSheetModal(for: self.window) { response in
                let approving = response == .alertSecondButtonReturn && Date().timeIntervalSince1970 * 1000 < expiry
                let body: [String: Any] = approving ? ["action": "approve", "digest": digest] : ["action": "revoke"]
                _ = EnrollmentControlRequest(url: url, token: token, body: body) { result in
                    self.enrollmentReviewBusy = false
                    let approved = approving && result?["approved"] as? Bool == true
                    if let onResult {
                        onResult(approved, approving && !approved ? "The app could not confirm this approval." : nil)
                    } else if approving {
                        self.enrollmentNotice(approved ? "Enrollment request allowed" : "Approval was not confirmed", approved ? "The local helper may now request enrollment. No workflow authority has been granted." : "The review may have expired or changed. Check the connection before trying again.")
                    }
                }
            }
        }
    }
    func enrollmentNotice(_ title: String, _ detail: String) {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail
        alert.addButton(withTitle: "OK"); alert.beginSheetModal(for: window)
    }
}
