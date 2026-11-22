import Cocoa
import SwiftUI

@MainActor final class MCPConnectionsWindow: NSWindowController, NSWindowDelegate {
    init(useResult: @escaping (String) async throws -> Void) {
        let window = NSWindow(contentRect:NSRect(x:0,y:0,width:620,height:660), styleMask:[.titled,.closable,.resizable], backing:.buffered, defer:false)
        super.init(window:window)
        window.title = "MCP connections"
        window.contentView = NSHostingView(rootView: MCPConnectionsView(useResult:useResult))
        window.center()
        window.isReleasedWhenClosed = false
        window.delegate = self
    }
    func windowWillClose(_ notification: Notification) { window?.contentView = nil }
    required init?(coder: NSCoder) { fatalError("Unsupported initializer") }
}

@MainActor private struct MCPConnectionsView: View {
    let useResult: (String) async throws -> Void
    @AppStorage("MCPServerEndpoints", store:UserDefaults(suiteName:"org.bittrees.ai.mcp-connections")) private var savedJSON = "[]"
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
    }
    private func connect() async {
        do {
            let url = try MCPClient.endpointURL(address)
            let connection = try MCPClient(endpoint:url, token:token)
            client = connection
            token = ""
            let advertised = try await connection.discover()
            try Task.checkCancellation()
            tools = advertised
            selected = advertised.first?.name ?? ""
            if !saved.contains(url.absoluteString) { save(saved + [url.absoluteString]) }
            status = "Connected · \(tools.count) tools"
        } catch {
            guard !Task.isCancelled else { return }
            client?.close(); client = nil
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
                Text("MCP connections").font(.title.bold())
                if client == nil {
                    if !saved.isEmpty {
                        Menu("Saved servers") {
                            ForEach(saved, id:\.self) { item in
                                Button(item) { address = item; token = ""; status = "" }
                            }
                        }
                    }
                    TextField("MCP endpoint URL", text:$address)
                        .onChange(of:address) { _ in token = ""; status = "" }
                    Button("Use Bittrees MCP") { address = "https://mcp.bittrees.org/mcp" }
                    SecureField("Access token, if required (this connection only)", text:$token)
                    HStack {
                        Button("Connect and list tools") { perform { await connect() } }
                            .disabled(address.isEmpty || busy)
                        if saved.contains(address) {
                            Button("Forget server") { save(saved.filter { $0 != address }); address = ""; token = "" }
                        }
                    }
                } else {
                    HStack {
                        Text(address).font(.headline).textSelection(.enabled)
                        Spacer()
                        Button("Disconnect") { disconnect() }
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
                if !status.isEmpty { Text(status).textSelection(.enabled) }
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
