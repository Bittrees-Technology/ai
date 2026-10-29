import Cocoa

// Prepared native presenter, not registered by any menu/helper/browser/model.
// A future trusted native owner must retain it until finish/cancel and cancel it
// during shutdown. It has no key, file, network, helper or permission access.
final class NativeInitialPairingConfirmation {
    private weak var parent: NSWindow?
    private var alert: NSAlert?
    private var gate: InitialPairingConfirmationGate?
    private var binding: (() -> InitialPairingReviewBinding?)?
    private var completion: (([String: String]?) -> Void)?
    private var timer: Timer?
    private var observers: [NSObjectProtocol] = []
    private func now() -> Double { Date().timeIntervalSince1970 * 1000 }

    // The binding callback reads only the native owner's remembered inspection
    // and reviewed source context, never fields copied from this proposal.
    @discardableResult
    func present(proposal: [String: Any], parent: NSWindow,
                 binding: @escaping () -> InitialPairingReviewBinding?,
                 completion: @escaping ([String: String]?) -> Void) -> Bool {
        precondition(Thread.isMainThread)
        guard self.completion == nil, parent.isVisible, NSApp.isActive,
              parent.attachedSheet == nil, let expected = binding(),
              let gate = InitialPairingConfirmationGate(proposal: proposal, binding: expected, now: now()) else {
            completion(nil)
            return false
        }
        self.parent = parent
        self.gate = gate
        self.binding = binding
        self.completion = completion
        let alert = NSAlert()
        alert.messageText = "Pair this local identity with its Roles owner?"
        alert.informativeText = gate.summary
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Pair identity only")
        // Return/Escape cannot approve. The second button requires a deliberate
        // native action; the response still rechecks expiry and remembered pins.
        alert.buttons[0].keyEquivalent = "\r"
        alert.buttons[1].keyEquivalent = ""
        self.alert = alert
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSWindow.willCloseNotification, object: parent, queue: .main) { [weak self] _ in self?.cancel() })
        observers.append(center.addObserver(forName: NSApplication.didResignActiveNotification, object: NSApp, queue: .main) { [weak self] _ in self?.cancel() })
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in self?.checkCurrent() }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
        alert.beginSheetModal(for: parent) { [weak self] response in
            self?.finish(approved: response == .alertSecondButtonReturn)
        }
        return true
    }
    private func checkCurrent() {
        precondition(Thread.isMainThread)
        guard let parent = parent, parent.isVisible, NSApp.isActive,
              let gate = gate, gate.isCurrent(binding: binding?(), now: now()) else { cancel(); return }
    }
    func cancel() { finish(approved: false) }
    private func finish(approved: Bool) {
        precondition(Thread.isMainThread)
        guard let callback = completion else { return }
        let visible = parent?.isVisible == true && NSApp.isActive
        let confirmation = gate?.finish(approved: approved && visible, binding: binding?(), now: now())
        // Clear before ending the sheet or calling the owner: both can reenter.
        completion = nil
        gate = nil
        binding = nil
        timer?.invalidate()
        timer = nil
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []
        let oldAlert = alert, oldParent = parent
        alert = nil
        parent = nil
        if let oldAlert = oldAlert, let oldParent = oldParent, oldParent.attachedSheet === oldAlert.window {
            oldParent.endSheet(oldAlert.window, returnCode: .abort)
        }
        callback(confirmation)
    }
}
