import Cocoa
import SwiftUI

@MainActor final class MCPConnectionsWindow: NSWindowController, NSWindowDelegate {
    init(store: UserDefaults = UserDefaults(suiteName: "org.bittrees.ai.mcp-connections") ?? .standard, useResult: @escaping (String) async throws -> Void) {
        let window = NSWindow(contentRect:NSRect(x:0,y:0,width:620,height:660), styleMask:[.titled,.closable,.resizable], backing:.buffered, defer:false)
        super.init(window:window)
        window.title = "MCP connections"
        window.contentView = NSHostingView(rootView: MCPConnectionsView(useResult:useResult).defaultAppStorage(store))
        window.center()
        window.isReleasedWhenClosed = false
        window.delegate = self
    }
    func windowWillClose(_ notification: Notification) { window?.contentView = nil }
    required init?(coder: NSCoder) { fatalError("Unsupported initializer") }
}

private enum MCPConnectionScreen {
    case servers, custom, token, connecting, connected
}

@MainActor private struct MCPConnectionsView: View {
    let useResult: (String) async throws -> Void
    @AppStorage("MCPServerEndpoints") private var savedJSON = "[]"
    private let bittreesURL = "https://mcp.bittrees.org/mcp"
    @State private var screen: MCPConnectionScreen = .servers
    @State private var showOptionalToken = false
    @FocusState private var tokenFocused: Bool
    @State private var address = ""
    @State private var token = ""
    @State private var client: MCPClient?
    @State private var tools: [MCPTool] = []
    @State private var selected = ""
    @State private var args = "{}"
    @State private var result = ""
    @State private var status = ""
    @State private var busy = false
    @State private var review = false
    @State private var operation: Task<Void,Never>?

    private var saved: [String] {
        (try? JSONDecoder().decode([String].self, from:Data(savedJSON.utf8))) ?? []
    }
    private var tool: MCPTool? { tools.first { $0.name == selected } }

    private func save(_ values: [String]) {
        if let data = try? JSONEncoder().encode(values) { savedJSON = String(decoding:data, as:UTF8.self) }
    }
    private func disconnect() {
        operation?.cancel()
        operation = nil
        client?.close()
        client = nil
        tools = []
        selected = ""
        token = ""
        result = ""
        args = "{}"
        review = false
        status = ""
        busy = false
        address = ""
        showOptionalToken = false
        screen = .servers
    }

    private func startConnection(_ endpoint: String) {
        let credential = token
        token = ""
        address = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        status = ""
        perform { await connect(address, token: credential) }
    }

    private func connect(_ endpoint: String, token: String) async {
        do {
            let url = try MCPClient.endpointURL(endpoint)
            let connection = try MCPClient(endpoint:url, token:token)
            client = connection
            screen = .connecting
            let advertised = try await connection.discover()
            try Task.checkCancellation()
            tools = advertised
            selected = advertised.first?.name ?? ""
            if !saved.contains(url.absoluteString) { save(saved + [url.absoluteString]) }
            screen = .connected
        } catch {
            guard !Task.isCancelled else { return }
            client?.close()
            client = nil
            screen = error is MCPAccessDenied ? .token : .custom
            status = error.localizedDescription
        }
    }
    private func runTool() async {
        guard let tool, let client else { return }
        do {
            guard let input = try JSONSerialization.jsonObject(with:Data(args.utf8)) as? [String:Any] else {
                throw MCPFailure("Enter arguments as a JSON object.")
            }
            let received = try await client.call(tool.name, arguments:input)
            try Task.checkCancellation()
            result = received
            status = "Result received from \(tool.name)"
        } catch {
            guard !Task.isCancelled else { return }
            result = ""
            status = error.localizedDescription + "\nCheck the source before repeating this operation."
        }
    }
    private func perform(_ action: @escaping @MainActor () async -> Void) {
        guard !busy else { return }
        busy = true
        operation = Task { await action(); if !Task.isCancelled { busy = false } }
    }

    var body: some View {
        ScrollView {
            VStack(alignment:.leading, spacing:14) {
                switch screen {
                case .servers:
                    Text("MCP connections").font(.largeTitle.bold())
                    Text("Connect a server to use its tools in Bittrees AI.")
                        .foregroundStyle(.secondary)
                    GroupBox {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Bittrees MCP").font(.headline)
                                Text(bittreesURL).font(.callout).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Connect") { startConnection(bittreesURL) }
                                .buttonStyle(.borderedProminent)
                                .accessibilityLabel("Connect to Bittrees MCP")
                        }.padding(6)
                    }
                    let others = saved.filter { $0 != bittreesURL }
                    if !others.isEmpty {
                        Text("Saved servers").font(.headline)
                        ForEach(others, id: \.self) { item in
                            HStack {
                                Text(item).font(.callout).textSelection(.enabled)
                                Spacer()
                                Button("Connect") { startConnection(item) }
                                    .accessibilityLabel("Connect to " + item)
                                Button { save(saved.filter { $0 != item }) } label: {
                                    Image(systemName: "trash")
                                }.help("Forget saved address").accessibilityLabel("Forget " + item)
                            }
                        }
                    }
                    Button("Add another server…") {
                        address = ""
                        screen = .custom
                    }
                case .custom, .token:
                    Button("Back to servers") { disconnect() }
                    if screen == .custom {
                        Text("Add an MCP server").font(.title.bold())
                        Text("Paste the MCP server URL provided by the app you want to connect.")
                        TextField("Server URL", text: $address, prompt: Text("https://example.org/mcp"))
                            .textFieldStyle(.roundedBorder)
                            .onChange(of: address) { _ in status = ""; token = "" }
                        DisclosureGroup("Access token (optional)", isExpanded: $showOptionalToken) {
                            SecureField("Server access token", text: $token).textFieldStyle(.roundedBorder)
                        }
                        .onChange(of: showOptionalToken) { expanded in if !expanded { token = "" } }
                    } else {
                        Text("Enter an access token").font(.title.bold())
                        Text(address).textSelection(.enabled)
                        SecureField("Server access token", text: $token)
                            .textFieldStyle(.roundedBorder).focused($tokenFocused)
                            .onAppear { tokenFocused = true }
                        Text("Use a token from this server. It is kept only for this connection.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    Button("Connect") { startConnection(address) }
                        .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                        .disabled(busy || address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                                  (screen == .token && token.isEmpty))
                case .connecting:
                    Text("Connecting to server…").font(.title.bold())
                    Text(address).textSelection(.enabled)
                    Button("Cancel") { disconnect() }
                case .connected:
                    HStack {
                        Label("Connected", systemImage: "checkmark.circle.fill").font(.headline)
                        Spacer()
                        Button("Disconnect") { disconnect() }
                    }
                    Text(address).textSelection(.enabled)
                    Button("Reconnect with a token…") {
                        let endpoint = address
                        disconnect()
                        address = endpoint
                        screen = .token
                    }.disabled(busy)
                    if tools.isEmpty {
                        Text("This server has no tools available for this connection.")
                    } else {
                        Text(tools.count == 1 ? "1 available tool" : "\(tools.count) available tools")
                            .foregroundStyle(.secondary)
                    }
                    if !tools.isEmpty {
                        Picker("Tool", selection:$selected) {
                            ForEach(tools) { Text($0.name).tag($0.name) }
                        }.disabled(busy)
                        .onChange(of:selected) { _ in args = "{}"; result = ""; status = "" }
                    }
                    if let tool {
                        Text(tool.description).textSelection(.enabled)
                        DisclosureGroup("Expected arguments") {
                            Text(tool.schema).font(.system(.caption, design:.monospaced)).textSelection(.enabled)
                        }
                        Text("Arguments (JSON)").font(.headline)
                        TextEditor(text:$args).font(.system(.body, design:.monospaced))
                            .frame(minHeight:72).border(Color.secondary.opacity(0.35)).disabled(busy)
                        Button("Review tool call…") { review = true }
                            .disabled(busy || args.utf8.count > 65_536 ||
                                !((try? JSONSerialization.jsonObject(with:Data(args.utf8))) is [String:Any]))
                    }
                }
                if busy { ProgressView().controlSize(.small) }
                if !status.isEmpty {
                    Text(status).font(.callout).textSelection(.enabled)
                }
                if !result.isEmpty {
                    Text("Server result").font(.headline)
                    ScrollView { Text(result).font(.system(.caption, design:.monospaced)).textSelection(.enabled).frame(maxWidth:.infinity, alignment:.leading) }
                        .frame(height:140)
                    Button("Add result to local task draft") {
                        perform {
                            do { try await useResult("Source data returned by MCP server \(address), tool \(selected):\n" + result)
                                status = "Added to your task draft." }
                            catch { status = error.localizedDescription }
                        }
                    }.disabled(busy)
                }
            }.padding(22).frame(maxWidth:.infinity, alignment:.leading)
        }
        .frame(minWidth:490,minHeight:450)
        .onDisappear { disconnect() }
        .sheet(isPresented:$review) {
            VStack(alignment:.leading, spacing:12) {
                Text("Run this tool?").font(.title2.bold())
                Text(address).textSelection(.enabled)
                Text(selected).font(.headline)
                ScrollView { Text(args).font(.system(.body, design:.monospaced)).textSelection(.enabled) }
                Text("The server will receive these arguments and may change data or incur charges.")
                HStack { Button("Cancel") { review = false }; Spacer()
                    Button("Run tool") { review = false; result = ""; status = ""; perform { await runTool() } }
                }
            }.padding(20).frame(width:460,height:320)
        }
    }
}
