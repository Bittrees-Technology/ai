import Cocoa

extension Companion {
    @objc func beginKitSetup() {
        guard recoveryPreview, ready, !recovery.busy, kitSetupId == nil, !quitting else { return }
        let alert = NSAlert()
        alert.messageText = "Create a recovery kit?"
        alert.informativeText = "This development preview has not completed independent review. It will create an encrypted copy of this Mac's storage key and a separate recovery code. Keep both, plus an encrypted data backup, to recover later. Bittrees cannot recover a lost code.\n\nYour current key and data will not be changed."
        alert.addButton(withTitle: "Create recovery kit")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { [weak self] result in
            guard result == .alertFirstButtonReturn, let self = self, !self.quitting, self.ready, self.engine?.isRunning == true, !self.recovery.busy, self.kitSetupId == nil else { return }
            self.prepareKit()
        }
    }
    func prepareKit() {
        guard let resources = Bundle.main.resourceURL else { kitSetupFailed(); return }
        let id = UUID(), process = Process(), input = Pipe(), output = Pipe()
        kitSetupId = id
        kitSetupProcess = process
        process.executableURL = resources.appendingPathComponent("node")
        process.currentDirectoryURL = resources.appendingPathComponent("engine")
        process.arguments = ["dist/apps/companion/recovery-setup-worker.js"]
        process.environment = ["HOME": NSHomeDirectory(), "TMPDIR": NSTemporaryDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8", "BITTREES_RECOVERY_PREVIEW": "1"]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            try input.fileHandleForWriting.write(contentsOf: Data("{\"operation\":\"prepare-recovery-kit-v1\",\"confirmed\":true}".utf8))
            try input.fileHandleForWriting.close()
        } catch { cancelKitSetup(); kitSetupFailed(); return }
        let timeout = DispatchWorkItem { [weak self] in
            guard let self = self, self.kitSetupId == id else { return }
            self.cancelKitSetup(); self.kitSetupFailed()
        }
        kitSetupTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 60, execute: timeout)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var data = Data(), readFailed = false
            do {
                while data.count <= 2048 {
                    guard let chunk = try output.fileHandleForReading.read(upToCount: 2049 - data.count), !chunk.isEmpty else { break }
                    data.append(chunk)
                }
                if data.count > 2048 { readFailed = true; if process.isRunning { process.terminate() } }
            } catch { readFailed = true; if process.isRunning { process.terminate() } }
            process.waitUntilExit()
            let success = !readFailed && process.terminationReason == .exit && process.terminationStatus == 0
            DispatchQueue.main.async {
                defer { data.resetBytes(in: 0..<data.count) }
                guard let self = self, self.kitSetupId == id, !self.quitting else { return }
                self.kitSetupTimeout?.cancel(); self.kitSetupTimeout = nil; self.kitSetupProcess = nil
                do {
                    guard success else { throw RecoverySetupError.invalid }
                    self.kitSetup = try RecoverySetupSession(response: data)
                    let expiry = DispatchWorkItem { [weak self] in
                        guard let self = self, self.kitSetupId == id else { return }
                        self.cancelKitSetup(); self.kitSetupFailed()
                    }
                    self.kitSetupTimeout = expiry
                    DispatchQueue.main.asyncAfter(deadline: .now() + 600, execute: expiry)
                    self.showKitCode(id)
                } catch { self.cancelKitSetup(); self.kitSetupFailed() }
            }
        }
    }
    func showKitCode(_ id: UUID) {
        guard kitSetupId == id, let code = kitSetup?.displayedCode() else { return }
        let alert = NSAlert()
        alert.messageText = "Save this recovery code separately"
        alert.informativeText = "Store this code in a safe place separate from the kit and data backup. You must enter your saved code on the next screen. The code is not saved by Bittrees. Copying it uses your system clipboard. Setup expires after ten minutes."
        let field = NSTextField(labelWithString: code)
        field.isSelectable = true
        field.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        field.frame = NSRect(x: 0, y: 0, width: 470, height: 28)
        alert.accessoryView = field
        alert.addButton(withTitle: "I saved the code")
        alert.addButton(withTitle: "Copy code")
        alert.addButton(withTitle: "Cancel")
        kitSetupSheet = alert.window
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self = self, self.kitSetupId == id else { return }
            self.kitSetupSheet = nil
            if response == .alertFirstButtonReturn { self.kitSetup?.acknowledgeSaved(); self.verifyKitCode(id) }
            else if response == .alertSecondButtonReturn {
                NSPasteboard.general.clearContents(); NSPasteboard.general.setString(code, forType: .string)
                self.showKitCode(id)
            } else { self.cancelKitSetup() }
        }
    }
    func verifyKitCode(_ id: UUID, retry: Bool = false) {
        guard kitSetupId == id, kitSetup?.phase == .verifying else { return }
        let alert = NSAlert()
        alert.messageText = retry ? "Code did not match — try again" : "Verify your saved recovery code"
        alert.informativeText = "Enter the code from the separate place where you saved it. After verification, choose where to save the encrypted kit."
        let input = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 440, height: 26))
        input.placeholderString = "Saved recovery code"
        alert.accessoryView = input
        alert.addButton(withTitle: "Verify and save kit")
        alert.addButton(withTitle: "Cancel")
        kitSetupSheet = alert.window
        alert.beginSheetModal(for: window) { [weak self] response in
            defer { input.stringValue = "" }
            guard let self = self, self.kitSetupId == id else { return }
            self.kitSetupSheet = nil
            guard response == .alertFirstButtonReturn else { self.cancelKitSetup(); return }
            if self.kitSetup?.verify(input.stringValue) == true { self.saveKit(id) }
            else if self.kitSetup?.phase == .finished { self.cancelKitSetup(); self.kitSetupFailed() }
            else { self.verifyKitCode(id, retry: true) }
        }
    }
    func saveKit(_ id: UUID) {
        guard kitSetupId == id, kitSetup?.phase == .saving else { return }
        let panel = NSSavePanel()
        panel.title = "Save encrypted recovery kit"
        panel.message = "Keep your recovery code separately. Choose a new filename; existing files will not be replaced."
        panel.nameFieldStringValue = "Bittrees-recovery.btkey"
        kitSetupSheet = panel
        panel.beginSheetModal(for: window) { [weak self] result in
            guard let self = self, self.kitSetupId == id else { return }
            self.kitSetupSheet = nil
            guard result == .OK, let url = panel.url else { self.cancelKitSetup(); return }
            do {
                guard let session = self.kitSetup else { throw RecoverySetupError.invalid }
                try saveRecoveryKit(session.verifiedKit(), to: url)
                self.cancelKitSetup()
                let alert = NSAlert()
                alert.messageText = "Recovery kit saved"
                alert.informativeText = "Keep the separate recovery code and a current encrypted data backup. This kit does not contain your task data, model files or app connection credentials. Creating a new kit does not revoke older kits."
                alert.addButton(withTitle: "OK"); alert.beginSheetModal(for: self.window)
            } catch { self.cancelKitSetup(); self.kitSetupFailed() }
        }
    }
    func cancelKitSetup() {
        kitSetupId = nil
        kitSetupTimeout?.cancel(); kitSetupTimeout = nil
        if kitSetupProcess?.isRunning == true { kitSetupProcess?.terminate() }
        kitSetupProcess = nil
        kitSetup?.clear(); kitSetup = nil
        if let sheet = kitSetupSheet { kitSetupSheet = nil; window.endSheet(sheet, returnCode: .cancel) }
    }
    func kitSetupFailed() {
        guard !quitting else { return }
        let alert = NSAlert()
        alert.messageText = "Recovery kit setup did not finish"
        alert.informativeText = "Check Keychain access, your saved code and the destination folder, then start again. No current key or task data was changed. Existing destination files were not replaced."
        alert.addButton(withTitle: "OK"); alert.beginSheetModal(for: window)
    }
}
