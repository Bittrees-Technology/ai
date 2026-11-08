import Foundation
import CryptoKit
import CoreFoundation

struct EnrollmentReviewDisplay {
    let digest: String
    let wallet: String
    let device: String
    let workspace: String
    let authority: String
    let principal: String
    let publicKey: String
    let expiresAt: Double
    let spendingSummary: String
    let identityPurpose: String
    static func parse(_ proposal: [String: Any]) -> EnrollmentReviewDisplay? {
        func integer(_ value: Any?) -> Double? {
            guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite,
                  value.doubleValue.rounded() == value.doubleValue, abs(value.doubleValue) <= 9007199254740991 else { return nil }
            return value.doubleValue
        }
        func text(_ value: Any?, maximum: Int) -> String? {
            guard let value = value as? String, !value.isEmpty, value.utf16.count <= maximum,
                  value.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
            return value
        }
        guard Set(proposal.keys) == Set(["review", "disclosure", "digest"]), let digest = proposal["digest"] as? String,
                  digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  let review = proposal["review"] as? [String: Any], let disclosure = proposal["disclosure"] as? [String: Any],
                  let serialized = try? JSONSerialization.data(withJSONObject: ["review": review, "disclosure": disclosure], options: [.sortedKeys, .withoutEscapingSlashes]),
                  SHA256.hash(data: serialized).map({ String(format: "%02x", $0) }).joined() == digest,
                  Set(review.keys) == Set(["epoch", "expiresAt", "authorityId", "deviceId", "sourceWorkspace", "principal", "publicKey", "ownerWallet"]),
                  let authority = review["authorityId"] as? String, UUID(uuidString: authority) != nil,
                  let epoch = review["epoch"] as? String, UUID(uuidString: epoch) != nil,
                  let principal = review["principal"] as? String, principal.hasPrefix("agent:"), UUID(uuidString: String(principal.dropFirst(6))) != nil,
                  let publicKey = review["publicKey"] as? String, publicKey.count <= 300, publicKey.hasPrefix("-----BEGIN PUBLIC KEY-----"),
                  let wallet = review["ownerWallet"] as? String, wallet.range(of: "^0x[a-f0-9]{40}$", options: .regularExpression) != nil,
                  let device = review["deviceId"] as? String, UUID(uuidString: device) != nil,
                  let workspace = review["sourceWorkspace"] as? String, UUID(uuidString: workspace) != nil,
                  let expiry = review["expiresAt"] as? Double,
                  expiry > Date().timeIntervalSince1970 * 1000, expiry <= Date().timeIntervalSince1970 * 1000 + 300000,
                  disclosure["hosts"] as? [String] == ["ai.bittrees.org", "roles.bittrees.org"],
                  disclosure["operations"] as? [String] == ["heartbeat", "start", "poll", "attest", "complete"],
                  disclosure["maximumDurationSeconds"] as? Int == 300,
                  disclosure["maximumCalls"] as? Int == 108,
                  disclosure["maximumPolls"] as? Int == 100,
                  disclosure["grantsWorkflowAuthority"] as? Bool == false else { return nil }
        let common = Set(["purpose", "hosts", "operations", "maximumDurationSeconds", "maximumCalls", "maximumPolls", "grantsWorkflowAuthority"])
        guard let purpose = disclosure["purpose"] as? String,
              ["Enroll this Mac in Roles; no workflow execution permission", "Enroll this Mac's central Workflows identity in Roles; no workflow execution permission"].contains(purpose) else { return nil }
        let lines = publicKey.components(separatedBy: "\n")
        guard lines.count == 4, lines[0] == "-----BEGIN PUBLIC KEY-----", lines[2] == "-----END PUBLIC KEY-----", lines[3].isEmpty,
              let der = Data(base64Encoded: lines[1]), der.count == 44,
              der.prefix(12) == Data([0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00]),
              lines[1] == der.base64EncodedString(), (try? Curve25519.Signing.PublicKey(rawRepresentation: der.suffix(32))) != nil else { return nil }
        let spending: String
        if disclosure["costBasis"] == nil {
            guard Set(disclosure.keys) == common.union(["additionalSpendingUSD"]), integer(disclosure["additionalSpendingUSD"]) == 0 else { return nil }
            spending = "Additional spending limit: US$0 (independently verified included usage)."
        } else {
            guard Set(disclosure.keys) == common.union(["costBasis", "maximumAdditionalMicroUSD", "maximumAggregateAttempts", "approvalId", "approvalReference", "approvalDigest", "approvalExpiresAt", "limitScope"]),
                  disclosure["costBasis"] as? String == "explicit-one-time-approval",
                  disclosure["limitScope"] as? String == "shared-native-runtime",
                  let maximum = integer(disclosure["maximumAdditionalMicroUSD"]), maximum >= 1, maximum <= 10000000,
                  let attempts = integer(disclosure["maximumAggregateAttempts"]), attempts >= 1, attempts <= 240,
                  let approval = text(disclosure["approvalId"], maximum: 128),
                  let reference = text(disclosure["approvalReference"], maximum: 1024),
                  let approvalDigest = disclosure["approvalDigest"] as? String, approvalDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  let approvalExpiry = integer(disclosure["approvalExpiresAt"]), approvalExpiry >= expiry else { return nil }
            let amount = Int(maximum), fraction = String(format: "%06d", amount % 1000000).replacingOccurrences(of: "0+$", with: "", options: .regularExpression)
            let dollars = String(amount / 1000000) + (fraction.isEmpty ? "" : "." + fraction)
            let fundingEnds = ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: approvalExpiry / 1000))
            spending = "Combined additional spending limit: US$\(dollars) on existing Neon/Vercel services. This same allowance covers enrollment, Workflows, CRM assignments and attestations; each helper does not receive another allowance. At most \(Int(attempts)) aggregate attempts.\nFunding expires: \(fundingEnds)\nApproval: \(approval)\nReference: \(reference)"
        }
        return EnrollmentReviewDisplay(digest: digest, wallet: wallet, device: device, workspace: workspace, authority: authority, principal: principal, publicKey: publicKey, expiresAt: expiry, spendingSummary: spending, identityPurpose: purpose)
    }
}
