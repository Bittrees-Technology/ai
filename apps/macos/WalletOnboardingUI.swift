import Cocoa
import Darwin

// Native presentation only. It has no wallet, signing, key creation, source
// registration, policy mutation or activation port.
final class NativeWalletOnboarding: NSObject, NSWindowDelegate {
    let window: NSWindow
    private let resources: URL?
    private let inspect: (() -> Void)?
    private var available = true
    private var selected = 0
    private var walletMode = 0
    private let walletChoices = NSStackView()
    private var identity: String?
    private var buttons: [NSButton] = []
    private let heading = NSTextField(labelWithString: "")
    private let status = NSTextField(wrappingLabelWithString: "")
    private let detail = NSTextField(wrappingLabelWithString: "")
    private let reviewText = NSTextView()
    private let reviewScroll = NSScrollView()
    private let comparisons = NSStackView()
    private let currentText = NSTextView()
    private let proposedText = NSTextView()
    private let inspectButton = NSButton(title: "Review local identity…", target: nil, action: nil)
    private let importButton = NSButton(title: "Review policy draft…", target: nil, action: nil)
    private let activation = NSButton(title: "Activation unavailable", target: nil, action: nil)
    private var draft: [String: Any]?
    private var reviewProcess: Process?
    private var timeout: DispatchWorkItem?
    private var reviewFailed = false

    init(resources: URL?, inspect: (() -> Void)?) {
        self.resources = resources; self.inspect = inspect
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 880, height: 660), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = "Bittrees AI — Agent setup"
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 760, height: 580)
        let root = NSStackView(); root.orientation = .horizontal; root.alignment = .top; root.spacing = 24
        root.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        let steps = NSStackView(); steps.orientation = .vertical; steps.alignment = .leading; steps.spacing = 16
        let name = NSTextField(wrappingLabelWithString: "Bittrees local AI\non this Mac")
        name.font = .systemFont(ofSize: 17, weight: .semibold); steps.addArrangedSubview(name)
        for (i, title) in ["1  Identity", "2  Wallet", "3  Permissions review", "4  Activation"].enumerated() {
            let b = NSButton(title: title, target: self, action: #selector(selectStage(_:))); b.tag = i; b.bezelStyle = .recessed
            b.alignment = .left; b.setAccessibilityLabel(title); buttons.append(b); steps.addArrangedSubview(b)
        }
        steps.widthAnchor.constraint(equalToConstant: 190).isActive = true
        let divider = NSBox(); divider.boxType = .separator; divider.widthAnchor.constraint(equalToConstant: 1).isActive = true
        let content = NSStackView(); content.orientation = .vertical; content.alignment = .leading; content.spacing = 16
        heading.font = .systemFont(ofSize: 25, weight: .semibold)
        status.font = .systemFont(ofSize: 14, weight: .semibold)
        detail.font = .systemFont(ofSize: 13); detail.textColor = .secondaryLabelColor
        for view in [heading, status, detail] { content.addArrangedSubview(view) }
        let actions = NSStackView(); actions.orientation = .horizontal; actions.spacing = 12
        inspectButton.target = self; inspectButton.action = #selector(inspectIdentity)
        importButton.target = self; importButton.action = #selector(importDraft)
        activation.isEnabled = false
        for b in [inspectButton, importButton, activation] { actions.addArrangedSubview(b) }
        walletChoices.orientation = .vertical; walletChoices.alignment = .leading; walletChoices.spacing = 8
        for (i, title) in ["Create a new agent Safe", "Connect an existing Safe"].enumerated() {
            let choice = NSButton(radioButtonWithTitle: title, target: self, action: #selector(selectWalletMode(_:))); choice.tag = i; walletChoices.addArrangedSubview(choice)
        }
        content.addArrangedSubview(walletChoices)
        content.addArrangedSubview(actions)
        let scroll = reviewScroll; scroll.hasVerticalScroller = true; scroll.borderType = .noBorder
        reviewText.isEditable = false; reviewText.isSelectable = true; reviewText.isRichText = false
        reviewText.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        reviewText.textContainerInset = NSSize(width: 10, height: 10)
        reviewText.autoresizingMask = [.width]; reviewText.isHorizontallyResizable = false
        reviewText.textContainer?.widthTracksTextView = true
        reviewText.setAccessibilityLabel("Policy draft comparison and setup requirements")
        scroll.documentView = reviewText; content.addArrangedSubview(scroll)
        scroll.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 260).isActive = true
        comparisons.orientation = .horizontal; comparisons.distribution = .fillEqually; comparisons.alignment = .top; comparisons.spacing = 12
        for (label, text) in [("Current · supplied, unverified", currentText), ("Proposed · draft only", proposedText)] {
            let column = NSStackView(); column.orientation = .vertical; column.alignment = .leading; column.spacing = 8
            let title = NSTextField(labelWithString: label); title.font = .systemFont(ofSize: 12, weight: .semibold); column.addArrangedSubview(title)
            let pane = NSScrollView(); pane.hasVerticalScroller = true; pane.borderType = .noBorder
            text.isEditable = false; text.isSelectable = true; text.isRichText = false; text.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
            text.textContainerInset = NSSize(width: 8, height: 8); text.autoresizingMask = [.width]; text.isHorizontallyResizable = false; text.textContainer?.widthTracksTextView = true
            text.setAccessibilityLabel(label + " policy comparison")
            pane.documentView = text; column.addArrangedSubview(pane)
            pane.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
            pane.heightAnchor.constraint(greaterThanOrEqualToConstant: 300).isActive = true
            comparisons.addArrangedSubview(column)
        }
        content.addArrangedSubview(comparisons)
        comparisons.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        root.addArrangedSubview(steps); root.addArrangedSubview(divider); root.addArrangedSubview(content)
        window.contentView = root; render()
    }
    func show() { available = true; render(); window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    func recordLocalIdentity(principal: String, fingerprint: String) {
        guard available else { return }
        identity = "Local key inspected\n\(principal)\nKey fingerprint: \(fingerprint)"; render()
    }
    func windowWillClose(_ notification: Notification) {
        available = false
        timeout?.cancel(); timeout = nil; draft = nil; identity = nil
        if let process = reviewProcess, process.isRunning { process.terminate() }
        reviewProcess = nil
    }
    @objc private func selectWalletMode(_ sender: NSButton) { walletMode = sender.tag; render() }
    @objc private func selectStage(_ sender: NSButton) { selected = sender.tag; render() }
    @objc private func inspectIdentity() { guard let inspect = inspect else { return }; window.orderOut(nil); inspect() }
    private func render() {
        reviewText.font = selected == 2 && draft != nil ? .monospacedSystemFont(ofSize: 12, weight: .regular) : .systemFont(ofSize: 13)
        let comparisonVisible = selected == 2 && draft != nil
        reviewScroll.isHidden = comparisonVisible; comparisons.isHidden = !comparisonVisible
        if let draft = draft, comparisonVisible {
            currentText.string = comparisonColumn(draft, proposed: false)
            proposedText.string = comparisonColumn(draft, proposed: true)
        }
        let titles = ["Identity", "Connect a wallet", "Review permissions", "Explicit activation"]
        heading.stringValue = titles[selected]
        for (i, b) in buttons.enumerated() { b.state = i == selected ? .on : .off }
        inspectButton.isHidden = selected != 0; inspectButton.isEnabled = inspect != nil
        importButton.isHidden = selected != 2; importButton.isEnabled = reviewProcess == nil
        activation.isHidden = selected != 3
        walletChoices.isHidden = selected != 1
        for case let choice as NSButton in walletChoices.arrangedSubviews { choice.state = choice.tag == walletMode ? .on : .off }
        if selected == 0 {
            status.stringValue = identity == nil ? "Local identity not inspected in this setup" : "Local key inspected; source enrollment unverified"
            detail.stringValue = "Only an active person with current applicable Roles may delegate. Reviewing a local key does not register a person, connect an agent or grant permissions."
            reviewText.string = identity ?? "Review the existing encrypted local identity through the separate native confirmation. Missing keys require a separate explicit creation confirmation.\n\nRoles person and current-role status: not verified\nAgent controller association: not verified"
        } else if selected == 1 {
            status.stringValue = walletMode == 0 ? "Creating a Safe is not available yet" : "Connecting a Safe is not available yet"
            detail.stringValue = "Ethereum mainnet. Wallet sign-in and transaction permission review are separate steps. Identity can be completed before a Safe exists. Neither deployment nor connection is performed by this review."
            let path = walletMode == 0 ? "Create a new agent Safe\nChoose real recovery owners and threshold in the wallet. Review a verified Ethereum factory/implementation deployment plan and gas estimate, then give explicit native wallet approval. The new Safe starts unfunded and without autonomous authority. Only a confirmed deployed address can proceed to policy review.\n\n" : "Connect an existing Safe\nConfirm the actual Safe address, owners and administrator threshold through the wallet and authorized source. Connection does not grant autonomous access.\n\n"
            reviewText.string = path + "Wallet: unverified\nSafe address and administrator threshold: unverified\nSeparate device-held transaction key: not created by this setup\n\nIdentity keys cannot sign wallet actions. Exact Bittrees sign-in domains and messages require their own review. A wallet sign-in never grants contract or spending authority.\n\nNo browser, wallet signature or transaction is opened here."
        } else if selected == 2 {
            status.stringValue = draft == nil ? "No policy draft reviewed" : "Draft reviewed locally; source and wallet authority unverified"
            detail.stringValue = "Default duration: Until revoked. Review an initial policy or amend the same authority. Imported current values are supplied by the document, not confirmed wallet limits."
            reviewText.string = draft.map(displayDraft) ?? "Choose a JSON document containing current and proposed policies. For first setup, current must be null.\n\nReview covers exact sign-in domains, contract targets and calldata, native/token period budgets, call counts and gas limits. Unknown calls and delegatecall remain denied.\n\nNo policy is saved, signed, submitted or activated by this review."
        } else {
            status.stringValue = "Activation is unavailable"
            detail.stringValue = "No reviewed source approval, confirmed wallet enforcement or native activation approval has been established. This setup cannot generate a transaction key or activate authority."
            reviewText.string = "Required before activation:\n• Verified enrolled agent and current active-person Roles\n• Actual Safe and recovery/admin threshold\n• Exact reviewed actions and budgets\n• Separate native transaction-key confirmation\n• Current source and Safe approvals\n• Confirmed enforcement and policy readback\n• Explicit native activation\n\nPending amendments retain existing confirmed limits. Editing never clears suspension or resets usage counters. Local suspension is not proof of onchain revocation. Expired authority requires a new activation review."
        }
    }
    private func displayDraft(_ value: [String: Any]) -> String { return "Draft reviewed. Supplied current values are unverified; no authority granted." }
    private func comparisonColumn(_ value: [String: Any], proposed: Bool) -> String {
        let revision = value[proposed ? "proposedRevision" : "expectedRevision"] ?? ""
        let digest = value[proposed ? "proposedPolicyDigest" : "expectedPolicyDigest"] ?? NSNull()
        var lines = ["Revision \(revision)", "Agent: \(value["agentId"] ?? "")", "Safe: \(value["safe"] ?? "")", "Signer: \(value["signer"] ?? "")", "Policy digest: \(digest)", ""]
        if !proposed { lines.append("These values are supplied by the document. No current wallet limit has been verified.\n") }
        else { lines.append("Draft only. Current confirmed limits continue while an amendment is pending. Editing cannot clear suspension or reset usage counters.\n") }
        for item in value["comparison"] as? [[String: Any]] ?? [] {
            lines.append("\(item["field"] ?? "Change")")
            let body = item[proposed ? "proposed" : "current"] ?? NSNull()
            let text = (try? JSONSerialization.data(withJSONObject: body, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed])).flatMap { String(data: $0, encoding: .utf8) } ?? "Unavailable"
            lines.append(text); lines.append("")
        }
        lines.append("No source, wallet or chain authority established.")
        return lines.joined(separator: "\n")
    }
    @objc private func importDraft() {
        guard available, reviewProcess == nil else { return }
        let picker = NSOpenPanel(); picker.canChooseDirectories = false; picker.allowsMultipleSelection = false
        picker.message = "Choose a wallet policy review document. Do not supply private keys or recovery material."
        picker.beginSheetModal(for: window) { response in
            guard self.available, response == .OK, let url = picker.url else { return }
            do {
                let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW)
                guard descriptor >= 0 else { throw NSError(domain: "WalletDraft", code: 1) }
                let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
                defer { try? file.close() }
                var info = stat()
                guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size <= 131072 else { throw NSError(domain: "WalletDraft", code: 1) }
                let data = try file.read(upToCount: 131073) ?? Data()
                guard data.count <= 131072 else { throw NSError(domain: "WalletDraft", code: 1) }
                self.review(data)
            } catch { self.draft = nil; self.render(); self.notice("Draft could not be read", "Choose a regular JSON policy review file under 128 KiB. Nothing was changed.") }
        }
    }
    private func review(_ input: Data) {
        guard available else { return }
        guard let resources = resources else { notice("Draft review unavailable", "The reviewed native helper is unavailable. No wallet or permission changed."); return }
        let process = Process(), stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
        process.arguments = ["-f", resources.appendingPathComponent("offline.sb").path, resources.appendingPathComponent("node").path, resources.appendingPathComponent("engine/dist/apps/companion/native-wallet-review.mjs").path]
        process.environment = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
        process.standardInput = stdin; process.standardOutput = stdout; process.standardError = stderr
        reviewProcess = process; draft = nil; reviewFailed = false; render()
        do {
            try process.run()
            let deadline = DispatchWorkItem { [weak self] in guard let self = self, self.reviewProcess === process else { return }; self.reviewFailed = true; if process.isRunning { process.terminate() } }
            timeout = deadline; DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: deadline)
            DispatchQueue.global(qos: .userInitiated).async {
                // Reading/writing on workers keeps the native UI responsive. The
                // fixed helper's stderr is a single bounded generic error.
                DispatchQueue.global(qos: .userInitiated).async { try? stdin.fileHandleForWriting.write(contentsOf: input); try? stdin.fileHandleForWriting.close() }
                var output = Data(), oversized = false
                while true {
                    let part = stdout.fileHandleForReading.readData(ofLength: 8192)
                    if part.isEmpty { break }
                    if output.count + part.count > 262144 { oversized = true; if process.isRunning { process.terminate() }; break }
                    output.append(part)
                }
                process.waitUntilExit()
                let finalOutput = output, tooLarge = oversized
                DispatchQueue.main.async {
                    guard self.reviewProcess === process else { return }
                    self.timeout?.cancel(); self.timeout = nil; self.reviewProcess = nil
                    if !self.reviewFailed, !tooLarge, process.terminationStatus == 0,
                       let result = (try? JSONSerialization.jsonObject(with: finalOutput)) as? [String: Any],
                       result["schema"] as? String == "bittrees.native.wallet-draft-review.v1",
                       result["grantsAuthority"] as? Bool == false, result["canActivate"] as? Bool == false,
                       result["transactionKeyCreated"] as? Bool == false {
                        self.draft = result; self.selected = 2; self.render()
                    } else { self.render(); self.notice("Draft review rejected", "The policy, amendment or review helper could not be verified. No wallet, key, policy or permission changed.") }
                }
            }
        } catch { reviewProcess = nil; render(); notice("Draft review unavailable", "The local helper could not start. Nothing was changed.") }
    }
    private func notice(_ title: String, _ text: String) { let alert = NSAlert(); alert.messageText = title; alert.informativeText = text; alert.addButton(withTitle: "OK"); alert.beginSheetModal(for: window) }
}
