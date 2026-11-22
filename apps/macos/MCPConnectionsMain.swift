import Cocoa

// Only the operator's explicit draft action writes to the parent. Closing the
// window emits no data. Credentials and the session live in this process.
@main final class MCPConnectionsMain: NSObject, NSApplicationDelegate {
    private var controller: MCPConnectionsWindow?
    static func main() {
        let app = NSApplication.shared
        let delegate = MCPConnectionsMain()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let edit = NSMenu(title:"Edit")
        for (title, selector, key) in [("Cut","cut:","x"), ("Copy","copy:","c"), ("Paste","paste:","v"), ("Select All","selectAll:","a")] {
            edit.addItem(withTitle:title, action:NSSelectorFromString(selector), keyEquivalent:key)
        }
        let applicationItem = NSMenuItem()
        menu.addItem(applicationItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle:"Close MCP connections", action:#selector(NSApplication.terminate(_:)), keyEquivalent:"q")
        applicationItem.submenu = appMenu
        let editItem = NSMenuItem()
        menu.addItem(editItem)
        editItem.submenu = edit
        NSApp.mainMenu = menu
        controller = MCPConnectionsWindow { evidence in
            guard evidence.utf16.count <= 32_000 else { throw MCPFailure("The result exceeds the local task limit. Select and copy an excerpt.") }
            try FileHandle.standardOutput.write(contentsOf:Data(evidence.utf8))
            NSApp.terminate(nil)
        }
        controller?.showWindow(nil)
        NSApp.activate(ignoringOtherApps:true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
