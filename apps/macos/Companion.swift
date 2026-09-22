import Cocoa
import WebKit

// The native shell owns only its child engine. Source permissions remain in the engine.
final class Companion: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, NSMenuItemValidation {
    var window: NSWindow!
    var web: WKWebView!
    var engine: Process?
    var output: Pipe?
    var lifetime: Pipe?
    var ready = false
    var quitting = false
    var buffer = ""
    var recovery = RecoveryLifecycle()
    var recoveryProcess: Process?
    var recoveryMessage: String?
    let home = URL(string: "http://127.0.0.1:43127/")!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let root = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Bittrees AI", action: #selector(showBuildInfo), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Copy pairing code", action: #selector(copyPairingCode), keyEquivalent: "p")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Restore from backup…", action: #selector(chooseBackup), keyEquivalent: "")
        appMenu.addItem(withTitle: "Restore previous copy…", action: #selector(choosePrevious), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit Bittrees AI", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        root.submenu = appMenu
        menu.addItem(root)
        let edit = NSMenuItem()
        let edits = NSMenu(title: "Edit")
        for (title, selector, key) in [("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edits.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        edit.submenu = edits
        menu.addItem(edit)
        NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 780), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Bittrees AI — Starting local engine"
        replaceWebView()
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startEngine()
    }
    @objc func showBuildInfo() {
        let alert = NSAlert()
        alert.messageText = "Bittrees AI — Development preview"
        var detail = "Build details are unavailable."
        if let url = Bundle.main.resourceURL?.appendingPathComponent("build-info.json"),
           let data = try? Data(contentsOf: url),
           let info = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let revision = info["sourceCommit"] as? String,
           revision.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil,
           let version = info["version"] as? String,
           let dirty = info["sourceDirty"] as? Bool {
            detail = "Version \(version) · Source \(revision.prefix(12))"
            if dirty { detail += "\nIncludes local source changes." }
        }
        alert.informativeText = detail + "\n\nLocal development build. Public signing and notarization are not complete."
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window)
    }
    func replaceWebView() {
        web?.stopLoading()
        web?.navigationDelegate = nil
        web?.uiDelegate = nil
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        window.contentView = web
    }
    func startEngine() {
        ready = false
        buffer = ""
        guard let resources = Bundle.main.resourceURL else { fail(); return }
        let process = Process()
        process.executableURL = resources.appendingPathComponent("node")
        process.currentDirectoryURL = resources.appendingPathComponent("engine")
        process.arguments = ["dist/apps/companion/start.js"]
        // Do not inherit NODE_OPTIONS, injected module paths, or shell credentials.
        process.environment = ["HOME": NSHomeDirectory(), "TMPDIR": NSTemporaryDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8", "BITTREES_DESKTOP": "1"]
        lifetime = Pipe()
        process.standardInput = lifetime
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        output = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            let text = String(decoding: data, as: UTF8.self)
            DispatchQueue.main.async {
                guard let self = self, self.engine === process, !self.recovery.busy, !self.quitting else { return }
                self.buffer = String((self.buffer + text).suffix(4096))
                if !self.ready && self.buffer.contains("Bittrees AI: http://127.0.0.1:43127") {
                    self.ready = true
                    self.window.title = "Bittrees AI — Local companion"
                    self.web.load(URLRequest(url: self.home))
                    if let message = self.recoveryMessage {
                        self.recoveryMessage = nil
                        let alert = NSAlert()
                        alert.messageText = "Recovery finished"
                        alert.informativeText = message + "\n\nPair this window again using Copy pairing code in the app menu."
                        alert.addButton(withTitle: "OK")
                        alert.beginSheetModal(for: self.window)
                    }
                }
            }
        }
        process.terminationHandler = { [weak self] ended in
            DispatchQueue.main.async {
                guard let self = self, self.engine === ended else { return }
                self.output?.fileHandleForReading.readabilityHandler = nil
                self.output = nil
                self.lifetime = nil
                self.engine = nil
                if self.recovery.busy {
                    switch self.recovery.engineStopped() {
                    case .recover: self.runRecovery()
                    case .quit: NSApp.reply(toApplicationShouldTerminate: true)
                    case .ignore: break
                    }
                }
                else if self.quitting { NSApp.reply(toApplicationShouldTerminate: true) }
                else { self.fail() }
            }
        }
        engine = process
        do { try process.run() } catch { fail() }
    }
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if [#selector(chooseBackup), #selector(choosePrevious), #selector(copyPairingCode)].contains(menuItem.action) {
            return ready && engine?.isRunning == true && !recovery.busy && !quitting && window.attachedSheet == nil
        }
        return true
    }
    @objc func chooseBackup() {
        guard ready, !recovery.busy, !quitting else { return }
        let panel = NSOpenPanel()
        panel.title = "Choose an encrypted Bittrees AI backup"
        panel.message = "Choose a coordinated .aib backup made by Bittrees AI. The original Keychain key is required."
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let file = panel.url else { return }
            self?.confirmRecovery(backup: file)
        }
    }
    @objc func choosePrevious() { confirmRecovery(backup: nil) }
    func confirmRecovery(backup: URL?) {
        guard ready, engine?.isRunning == true, !recovery.busy, !quitting else { return }
        let alert = NSAlert()
        alert.messageText = backup == nil ? "Restore the previous copy?" : "Restore this backup?"
        alert.informativeText = "The app will finish stopping its local engine, restore a fresh copy of task and memory data, then restart. Current data is kept in a separate folder. Downloaded model files and connection credentials stay in place. Remote control permissions must be approved again.\n\nKeep a current encrypted backup before continuing. You will need to pair this window again. This does not downgrade the app or recover a missing Keychain key."
        alert.addButton(withTitle: "Restore and restart")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self = self,
                  let process = self.engine, process.isRunning, !self.quitting,
                  self.recovery.begin(backup: backup) else { return }
            self.ready = false
            self.replaceWebView() // Discard the old session and pending browser requests.
            self.window.title = "Bittrees AI — Finishing local work before recovery"
            process.terminate() // Only the engine owned by this app; never Ollama or other apps.
        }
    }
    func runRecovery() {
        guard let resources = Bundle.main.resourceURL else { finishRecovery(success: false); return }
        window.title = "Bittrees AI — Restoring a separate copy"
        let process = Process()
        process.executableURL = resources.appendingPathComponent("node")
        process.currentDirectoryURL = resources.appendingPathComponent("engine")
        process.arguments = ["dist/apps/companion/activate-cli.js"] + recovery.arguments
        process.environment = ["HOME": NSHomeDirectory(), "TMPDIR": NSTemporaryDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] ended in
            DispatchQueue.main.async {
                guard let self = self, self.recoveryProcess === ended else { return }
                self.recoveryProcess = nil
                self.finishRecovery(success: ended.terminationReason == .exit && ended.terminationStatus == 0)
            }
        }
        recoveryProcess = process
        do { try process.run() } catch { recoveryProcess = nil; finishRecovery(success: false) }
    }
    func finishRecovery(success: Bool) {
        guard recovery.finished() else { NSApp.reply(toApplicationShouldTerminate: true); return }
        recoveryMessage = success
            ? "Your recovered copy is now selected. Earlier copies are retained; current source permissions still apply."
            : "Recovery could not be confirmed. Your earlier data copies are retained. Check the chosen backup, original Keychain key and available space. For a previous-copy restore, an earlier selection must exist."
        window.title = "Bittrees AI — Restarting local engine"
        startEngine()
    }
    func fail() {
        web?.stopLoading()
        let alert = NSAlert()
        alert.messageText = "The local companion could not run"
        alert.informativeText = "Close any other Bittrees companion, check Keychain access, and reopen this app. Your saved data has not been reset."
        alert.runModal()
        NSApp.terminate(nil)
    }
    @objc func copyPairingCode() {
        guard ready, engine?.isRunning == true else { return }
        let file = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/Bittrees AI/pairing-code.txt")
        guard let code = try? String(contentsOf: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), code.range(of: "^[a-f0-9]{24}$", options: .regularExpression) != nil else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
    }
    func local(_ url: URL) -> Bool {
        url.scheme == "http" && url.host == "127.0.0.1" && url.port == 43127 && url.user == nil && url.password == nil
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if local(url) || (action.shouldPerformDownload && url.absoluteString.hasPrefix("blob:http://127.0.0.1:43127/")) {
            decisionHandler(action.shouldPerformDownload ? .download : .allow)
        } else {
            decisionHandler(.cancel)
            if action.navigationType == .linkActivated && url.scheme == "https" { NSWorkspace.shared.open(url) }
        }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme == "https" { NSWorkspace.shared.open(url) }
        return nil
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard let url = frame.request.url, local(url) else { completionHandler(false); return }
        let alert = NSAlert()
        alert.messageText = "Bittrees AI"
        alert.informativeText = message
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if recovery.requestQuit() {
            quitting = true
            window.title = "Bittrees AI — Finishing recovery before quitting"
            return .terminateLater
        }
        guard let process = engine, process.isRunning else { return .terminateNow }
        quitting = true
        window.title = "Bittrees AI — Finishing local shutdown"
        process.terminate()
        return .terminateLater
    }
}
@main
struct CompanionMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = Companion()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}
