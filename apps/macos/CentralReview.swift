import Foundation
import CoreFoundation
import CryptoKit

struct CentralReviewDisplay {
    let digest: String
    let wallet: String
    let principal: String
    let keyDigest: String
    let delegation: String
    let tenant: String
    let workspace: String
    let workflow: String
    let connection: String
    let maximumAttempts: Int
    let maximumMicroUSD: Int
    let attemptCeilingMicroUSD: Int
    let evidence: String
    let costBasis: String
    let expiresAt: Double
    static func parse(_ proposal: [String: Any], now: Double = Date().timeIntervalSince1970 * 1000) -> CentralReviewDisplay? {
        func text(_ object: [String: Any], _ key: String, _ maximum: Int) -> String? {
            guard let value = object[key] as? String, !value.isEmpty, value.utf16.count <= maximum,
                  value.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
            return value
        }
        func uuid(_ object: [String: Any], _ key: String) -> String? {
            guard let value = object[key] as? String, UUID(uuidString: value) != nil else { return nil }
            return value
        }
        func integer(_ object: [String: Any], _ key: String) -> Double? {
            guard let value = object[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
                  value.doubleValue.isFinite, value.doubleValue.rounded() == value.doubleValue,
                  abs(value.doubleValue) <= 9007199254740991 else { return nil }
            return value.doubleValue
        }
        guard Set(proposal.keys) == Set(["version", "purpose", "digest", "review"]),
              integer(proposal, "version") == 1,
              proposal["purpose"] as? String == "bounded-central-workflow-verification",
              let digest = proposal["digest"] as? String, digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let review = proposal["review"] as? [String: Any], Set(review.keys) == Set(["ownerWallet", "scope", "budget"]),
              let serialized = try? JSONSerialization.data(withJSONObject: review, options: [.sortedKeys, .withoutEscapingSlashes]),
              SHA256.hash(data: serialized).map({ String(format: "%02x", $0) }).joined() == digest,
              let wallet = review["ownerWallet"] as? String, wallet.range(of: "^0x[a-f0-9]{40}$", options: .regularExpression) != nil,
              let scope = review["scope"] as? [String: Any],
              Set(scope.keys) == Set(["epoch", "approvedAt", "expiresAt", "principal", "publicKey", "credentialId", "delegationId", "tenant", "workspace", "workflowId", "connectionId"]),
              let budget = review["budget"] as? [String: Any],
              Set(budget.keys) == Set(["epoch", "approvedAt", "expiresAt", "maximumAttempts", "evidenceId", "costBasis", "maximumMicroUSD", "attemptCeilingMicroUSD"]),
              let epoch = uuid(scope, "epoch"), uuid(budget, "epoch") == epoch,
              let approved = integer(scope, "approvedAt"), approved >= 0, approved <= now, integer(budget, "approvedAt") == approved,
              let expiry = integer(scope, "expiresAt"), expiry > now, expiry - approved <= 3600000, integer(budget, "expiresAt") == expiry,
              let principal = scope["principal"] as? String, principal.range(of: "^agent:[a-f0-9-]{36}$", options: .regularExpression) != nil,
              UUID(uuidString: String(principal.dropFirst(6))) != nil,
              let publicKey = scope["publicKey"] as? String, publicKey.utf8.count <= 512,
              let keyDigest = scope["credentialId"] as? String,
              SHA256.hash(data: Data(publicKey.utf8)).map({ String(format: "%02x", $0) }).joined() == keyDigest,
              let delegation = uuid(scope, "delegationId"), let connection = uuid(scope, "connectionId"),
              let tenant = text(scope, "tenant", 128), let workspace = text(scope, "workspace", 128), let workflow = text(scope, "workflowId", 128),
              let attempts = integer(budget, "maximumAttempts"), attempts >= 1, attempts <= 108,
              let maximum = integer(budget, "maximumMicroUSD"), maximum >= 0, maximum <= 1000000,
              let ceiling = integer(budget, "attemptCeilingMicroUSD"), ceiling >= 0, ceiling <= maximum,
              let evidence = text(budget, "evidenceId", 128), let basis = budget["costBasis"] as? String else { return nil }
        if basis == "verified-included-usage" { guard maximum == 0, ceiling == 0 else { return nil } }
        else if basis == "explicit-one-time-approval" { guard maximum > 0, ceiling > 0 else { return nil } }
        else { return nil }
        let lines = publicKey.components(separatedBy: "\n")
        guard lines.count == 4, lines[0] == "-----BEGIN PUBLIC KEY-----", lines[2] == "-----END PUBLIC KEY-----", lines[3].isEmpty,
              let der = Data(base64Encoded: lines[1]), der.count == 44,
              der.prefix(12) == Data([0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00]),
              lines[1] == der.base64EncodedString(),
              (try? Curve25519.Signing.PublicKey(rawRepresentation: der.suffix(32))) != nil else { return nil }
        return CentralReviewDisplay(digest: digest, wallet: wallet, principal: principal, keyDigest: keyDigest, delegation: delegation, tenant: tenant, workspace: workspace, workflow: workflow, connection: connection, maximumAttempts: Int(attempts), maximumMicroUSD: Int(maximum), attemptCeilingMicroUSD: Int(ceiling), evidence: evidence, costBasis: basis, expiresAt: expiry)
    }
}
