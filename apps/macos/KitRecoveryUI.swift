import Cocoa

extension Companion {
    func showRecoveryStart() {
        window.title = "Bittrees AI — Development recovery preview"
        let alert = NSAlert()
        alert.messageText = "Start the companion or recover existing data"
        alert.informativeText = "If you are restoring to this Mac, recover before starting: a new companion creates its own storage key. Recovery requires your encrypted backup, recovery kit and saved code. This preview still needs independent review and native acceptance."
        alert.addButton(withTitle: "Start companion")
        alert.addButton(withTitle: "Recover with kit…")
        alert.addButton(withTitle: "Quit")
        alert.beginSheetModal(for: window) { [weak self] choice in
            guard let self = self, !self.quitting else { return }
            if choice == .alertFirstButtonReturn { self.startFromRecoveryScreen() }
            else if choice == .alertSecondButtonReturn { self.chooseKitRecovery() }
            else { NSApp.terminate(nil) }
        }
    }
    @objc func startFromRecoveryScreen() {
        guard recoveryPreview, engine == nil, !recovery.busy, !kitRecoveryChoosing, !quitting else { return }
        startEngine()
    }
    @objc func chooseKitRecovery() {
        guard recoveryPreview, !recovery.busy, kitSetupId == nil, !kitRecoveryChoosing, !quitting, engine == nil || ready else { return }
        kitRecoveryChoosing = true
        pickRecoveryFile(title: "Choose encrypted content backup", message: "Choose your coordinated Bittrees .aib task and memory backup.") { [weak self] backup in
            guard let self = self, !self.quitting else { return }
            guard let backup = backup else { self.kitRecoveryChoosing = false; return }
            self.pickRecoveryFile(title: "Choose recovery kit", message: "Choose the .btkey file that matches your saved recovery code.") { [weak self] kit in
                guard let self = self, !self.quitting else { return }
                guard let kit = kit else { self.kitRecoveryChoosing = false; return }
                self.confirmKitRecovery(backup: backup, kit: kit)
            }
        }
    }
    func pickRecoveryFile(title: String, message: String, completion: @escaping (URL?) -> Void) {
        let panel = NSOpenPanel()
        panel.title = title; panel.message = message
        panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window) { choice in completion(choice == .OK ? panel.url : nil) }
    }
    func confirmKitRecovery(backup: URL, kit: URL) {
        let alert = NSAlert()
        alert.messageText = "Recover and select a separate copy?"
        alert.informativeText = "Backup: \(backup.lastPathComponent)\nKit: \(kit.lastPathComponent)\n\nEnter your saved recovery code. The app will stop only its own engine, validate the backup and current data, and add a missing Keychain key without replacing an existing one. It selects the recovered copy only after verifying the key. Earlier data is retained; remote permissions must be approved again. Quit during recovery waits for it to finish. This is a development preview pending independent review."
        let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 440, height: 26))
        field.placeholderString = "Saved recovery code"; alert.accessoryView = field
        alert.addButton(withTitle: "Recover and select copy")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { [weak self] choice in
            defer { field.stringValue = "" }
            guard let self = self, !self.quitting else { return }
            self.kitRecoveryChoosing = false
            guard choice == .alertFirstButtonReturn else { return }
            let code = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard code.range(of: "^btr1_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
                  backup.isFileURL, kit.isFileURL,
                  let input = try? JSONSerialization.data(withJSONObject: ["operation": "recover-with-kit-v1", "confirmed": true, "backup": backup.path, "kit": kit.path, "code": code]), input.count <= 32768,
                  self.recovery.beginKit(engineRunning: self.engine?.isRunning == true) else {
                self.presentKitRecovery(.invalidInput); return
            }
            self.kitRecoveryInput = input
            self.ready = false; self.replaceWebView()
            self.window.title = "Bittrees AI — Preparing recovery"
            if let engine = self.engine, engine.isRunning { engine.terminate() }
            else { self.runKitRecovery() }
        }
    }
    func clearKitRecoveryInput() {
        if let count = kitRecoveryInput?.count { kitRecoveryInput!.resetBytes(in: 0..<count) }
        kitRecoveryInput = nil
    }
    func runKitRecovery() {
        guard let resources = Bundle.main.resourceURL, let request = kitRecoveryInput else { finishKitRecovery(data: Data(), exitedNormally: false); return }
        window.title = "Bittrees AI — Verifying and recovering data"
        let process = Process(), input = Pipe(), output = Pipe()
        process.executableURL = resources.appendingPathComponent("node")
        process.currentDirectoryURL = resources.appendingPathComponent("engine")
        process.arguments = ["dist/apps/companion/kit-recovery-worker.js"]
        process.environment = ["HOME": NSHomeDirectory(), "TMPDIR": NSTemporaryDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8", "BITTREES_RECOVERY_PREVIEW": "1"]
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        recoveryProcess = process
        do { try process.run() }
        catch { recoveryProcess = nil; finishKitRecovery(data: Data(), exitedNormally: false); return }
        clearKitRecoveryInput()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var request = request
            var data = Data(), valid = true
            do { try input.fileHandleForWriting.write(contentsOf: request) }
            catch { valid = false }
            try? input.fileHandleForWriting.close()
            request.resetBytes(in: 0..<request.count)
            // Never kill a recovery operation on a timeout/oversized response: a key write may already have occurred.
            do {
                while let chunk = try output.fileHandleForReading.read(upToCount: 2048), !chunk.isEmpty {
                    if valid && data.count + chunk.count <= 2048 { data.append(chunk) }
                    else { valid = false; data.removeAll() }
                }
            } catch { valid = false }
            process.waitUntilExit()
            let success = valid && process.terminationReason == .exit && process.terminationStatus == 0
            DispatchQueue.main.async {
                guard let self = self, self.recoveryProcess === process else { return }
                self.recoveryProcess = nil
                self.finishKitRecovery(data: valid ? data : Data(), exitedNormally: success)
            }
        }
    }
    func finishKitRecovery(data: Data, exitedNormally: Bool) {
        clearKitRecoveryInput()
        guard recovery.finished() else { NSApp.reply(toApplicationShouldTerminate: true); return }
        presentKitRecovery(KitRecoveryReply(data: data, exitedNormally: exitedNormally))
    }
    func presentKitRecovery(_ result: KitRecoveryReply) {
        guard !quitting else { return }
        window.title = "Bittrees AI — Recovery result"
        let alert = NSAlert()
        alert.messageText = result.succeeded ? "Recovery verified" : "Recovery needs attention"
        alert.informativeText = result.message
        alert.addButton(withTitle: result.succeeded ? "Open companion" : "OK")
        alert.beginSheetModal(for: window) { [weak self] _ in
            guard let self = self, !self.quitting else { return }
            if result.succeeded { self.startFromRecoveryScreen() }
        }
    }
}
