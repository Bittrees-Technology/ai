import Foundation

struct MCPFailure: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

struct MCPAccessDenied: LocalizedError {
    let errorDescription: String?
    init(hasToken: Bool, forbidden: Bool) {
        if hasToken {
            errorDescription = "Access denied. Check that your token is valid and has permission for this server."
        } else if forbidden {
            errorDescription = "Access denied. Use a token with permission for this server."
        } else {
            errorDescription = "This server requires authentication."
        }
    }
}

struct MCPTool: Identifiable {
    var id: String { name }
    let name: String
    let description: String
    let schema: String
}

private final class ExactEndpoint: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

// Each instance belongs to one user-selected endpoint and one explicit connection.
@MainActor final class MCPClient {
    let endpoint: URL
    private let token: String
    private let transport: URLSession
    private var sessionID: String?
    private var version: String?
    private var tools = Set<String>()
    private let limit = 1024 * 1024

    static func endpointURL(_ raw: String) throws -> URL {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: trimmed), let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              (parts.scheme == "https" || (parts.scheme == "http" && ["127.0.0.1","[::1]"].contains(host))),
              let url = parts.url else {
            throw MCPFailure("Enter an HTTPS MCP endpoint without a query, password or fragment. Local servers can use HTTP on 127.0.0.1 or [::1].")
        }
        return url
    }

    init(endpoint: URL, token: String) throws {
        self.endpoint = try Self.endpointURL(endpoint.absoluteString)
        guard token.utf8.allSatisfy({ (33...126).contains($0) }) else { throw MCPFailure("Check the access token for spaces or line breaks.") }
        self.token = token
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 45
        transport = URLSession(configuration: config, delegate: ExactEndpoint(), delegateQueue: nil)
    }

    func close() { tools.removeAll(); transport.invalidateAndCancel() }

    func discover() async throws -> [MCPTool] {
        let initResult = try await send("initialize", [
            "protocolVersion":"2025-11-25", "capabilities":[:],
            "clientInfo":["name":"Bittrees AI","version":"1"]
        ])
        guard let negotiated = initResult["protocolVersion"] as? String,
              ["2025-11-25","2025-06-18","2025-03-26"].contains(negotiated),
              let capabilities = initResult["capabilities"] as? [String:Any],
              capabilities["tools"] is [String:Any] else { throw MCPFailure("The server needs a supported HTTP MCP version and the tools capability.") }
        version = negotiated
        _ = try await send("notifications/initialized", [:], notification: true)
        var list: [MCPTool] = []
        var names = Set<String>(), cursors = Set<String>()
        var cursor: String?
        repeat {
            let page = try await send("tools/list", cursor.map { ["cursor":$0] } ?? [:])
            guard let items = page["tools"] as? [[String:Any]] else { throw MCPFailure("The server returned an invalid tool list.") }
            for item in items {
                guard let name = item["name"] as? String, !name.isEmpty, names.insert(name).inserted,
                      let schema = item["inputSchema"] as? [String:Any], list.count < 512 else {
                    throw MCPFailure("The server returned an invalid, duplicate or oversized tool list.")
                }
                list.append(MCPTool(name:name, description:item["description"] as? String ?? "", schema:try Self.pretty(schema)))
            }
            cursor = page["nextCursor"] as? String
            if let next = cursor, !cursors.insert(next).inserted || cursors.count > 32 { throw MCPFailure("The server returned too many tool pages.") }
        } while cursor != nil
        tools = names
        return list
    }

    func call(_ name: String, arguments: [String:Any]) async throws -> String {
        guard tools.contains(name) else { throw MCPFailure("Reconnect and select an advertised tool.") }
        let result = try await send("tools/call", ["name":name,"arguments":arguments])
        guard result["content"] is [[String:Any]] else { throw MCPFailure("The server returned an invalid tool result.") }
        let rendered = try Self.pretty(result)
        if result["isError"] as? Bool == true { throw MCPFailure("The tool reported an error.\n" + rendered) }
        return rendered
    }

    static func pretty(_ object: [String:Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted,.sortedKeys,.withoutEscapingSlashes])
        return String(decoding: data, as: UTF8.self)
    }

    private func send(_ method: String, _ params: [String:Any], notification: Bool = false) async throws -> [String:Any] {
        let id = UUID().uuidString
        var body: [String:Any] = ["jsonrpc":"2.0","method":method,"params":params]
        if !notification { body["id"] = id }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.setValue("application/json", forHTTPHeaderField:"Content-Type")
        request.setValue("application/json, text/event-stream", forHTTPHeaderField:"Accept")
        request.setValue(version, forHTTPHeaderField:"MCP-Protocol-Version")
        request.setValue(sessionID, forHTTPHeaderField:"Mcp-Session-Id")
        if !token.isEmpty { request.setValue("Bearer " + token, forHTTPHeaderField:"Authorization") }
        let (bytes, raw) = try await transport.bytes(for: request)
        defer { bytes.task.cancel() }
        guard let http = raw as? HTTPURLResponse else { throw MCPFailure("Expected an HTTP response.") }
        switch http.statusCode {
        case 200..<300: break
        case 401,403: throw MCPAccessDenied(hasToken: !token.isEmpty, forbidden: http.statusCode == 403)
        case 404 where sessionID == nil: throw MCPFailure("Server URL not found. Check the exact MCP URL provided by the app.")
        case 404 where sessionID != nil: throw MCPFailure("The session expired. Reconnect to the server.")
        case 300..<400: throw MCPFailure("The server redirected. Register its final endpoint directly.")
        default: throw MCPFailure("Server returned HTTP \(http.statusCode).")
        }
        if method == "initialize", let value = http.value(forHTTPHeaderField:"Mcp-Session-Id") {
            guard !value.isEmpty, value.utf8.count <= 4096, value.utf8.allSatisfy({ (33...126).contains($0) }) else { throw MCPFailure("Invalid MCP session identifier.") }
            sessionID = value
        }
        if notification { return [:] }
        let isStream = http.mimeType == "text/event-stream"
        guard isStream || http.mimeType == "application/json" else { throw MCPFailure("This URL did not return an MCP response.") }
        var buffer = Data(), event = Data(), size = 0
        for try await byte in bytes {
            size += 1
            guard size <= limit else { throw MCPFailure("Response exceeded 1 MiB.") }
            if isStream && byte == 10 {
                if buffer.last == 13 { buffer.removeLast() }
                if buffer.isEmpty && !event.isEmpty {
                    if let result = try response(event, id: id, stream: true) { return result }
                    event.removeAll(keepingCapacity: true)
                } else if buffer.starts(with: "data:".utf8) {
                    var value = buffer.dropFirst(5)
                    if value.first == 32 { value = value.dropFirst() }
                    event.append(contentsOf:value); event.append(10)
                }
                buffer.removeAll(keepingCapacity: true)
            } else { buffer.append(byte) }
        }
        if !isStream, let result = try response(buffer, id:id, stream:false) { return result }
        throw MCPFailure("The server closed before a matching reply arrived.")
    }

    private func response(_ data: Data, id: String, stream: Bool) throws -> [String:Any]? {
        guard let rpc = try JSONSerialization.jsonObject(with: data) as? [String:Any], rpc["jsonrpc"] as? String == "2.0" else {
            throw MCPFailure("Invalid JSON-RPC response.")
        }
        if stream && rpc["method"] != nil && rpc["id"] == nil { return nil }
        guard rpc["id"] as? String == id else { throw MCPFailure("The reply did not match this request.") }
        if let error = rpc["error"] as? [String:Any] { throw MCPFailure(error["message"] as? String ?? "The server rejected the request.") }
        guard let result = rpc["result"] as? [String:Any] else { throw MCPFailure("Missing MCP result.") }
        return result
    }
}
