import Foundation
import CoreFoundation
import CryptoKit

// Inactive display validator only. No key access, transport or approval action.
// Expected fingerprints must come from native inspection/reviewed source config,
// never from the proposal itself. No UI or helper currently registers this flow.
struct InitialPairingReviewDisplay {
    let reviewId: String
    let digest: String
    let principal: String
    let keyFingerprint: String
    let rolesKeyFingerprint: String
    let expiresAt: Double
    func confirmation(now: Double = Date().timeIntervalSince1970 * 1000) -> [String: String]? {
        guard now.isFinite, now >= 0, expiresAt > now, expiresAt <= now + 300000 else { return nil }
        return ["reviewId": reviewId, "digest": digest]
    }
    var summary: String {
        "Bittrees local AI on this Mac\n\nLocal principal: \(principal)\nDevice key fingerprint: \(keyFingerprint)\nRoles source key fingerprint: \(rolesKeyFingerprint)\n\nPurpose: metadata-only owner pairing. Roles derives the owner from its authenticated active person with a current applicable role.\n\nRequests: HTTPS POST to https://roles.bittrees.org/api/mcp/pairing/start and /api/mcp/pairing/poll only. Maximum 62 requests over the original five-minute review; expires \(ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: expiresAt / 1000))).\n\nAdditional spending limit: $0; current source and cost admission remain required. No workflow permission, runtime enrollment, wallet or Safe approval is granted."
    }
    private static func integer(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let n = number.doubleValue
        return n.isFinite && n >= 0 && n <= 9007199254740991 && n.rounded(.down) == n ? n : nil
    }
    private static func isFalse(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return false }
        return !number.boolValue
    }
    private static func hex(_ value: Any?) -> String? {
        guard let text = value as? String, text.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { return nil }
        return text
    }
    static func parse(_ proposal: [String: Any], expectedPrincipal: String,
                      expectedKeyFingerprint: String, expectedRolesKeyFingerprint: String,
                      now: Double = Date().timeIntervalSince1970 * 1000) -> InitialPairingReviewDisplay? {
        guard now.isFinite, now >= 0, now <= 9007199254740991,
              Set(proposal.keys) == Set(["review", "digest"]),
              let digest = hex(proposal["digest"]), let review = proposal["review"] as? [String: Any],
              Set(review.keys) == Set(["version", "reviewId", "target", "purpose", "principal", "keyFingerprint", "rolesKeyFingerprint", "startEndpoint", "pollEndpoint", "ownerResolution", "sourceAdmission", "permissionsGranted", "runtimeEnrolled", "walletOrSafeApproval", "maximumCalls", "maximumDurationSeconds", "additionalSpendingUSD", "expiresAt"]),
              integer(review["version"]) == 1,
              let reviewId = review["reviewId"] as? String, UUID(uuidString: reviewId) != nil,
              reviewId == reviewId.lowercased(),
              review["target"] as? String == "Bittrees local AI on this Mac",
              review["purpose"] as? String == "metadata-only-owner-pairing",
              let principal = review["principal"] as? String, principal == expectedPrincipal,
              principal.hasPrefix("agent:"), UUID(uuidString: String(principal.dropFirst(6))) != nil,
              principal == principal.lowercased(),
              let local = hex(review["keyFingerprint"]), local == expectedKeyFingerprint,
              let source = hex(review["rolesKeyFingerprint"]), source == expectedRolesKeyFingerprint,
              review["startEndpoint"] as? String == "https://roles.bittrees.org/api/mcp/pairing/start",
              review["pollEndpoint"] as? String == "https://roles.bittrees.org/api/mcp/pairing/poll",
              review["ownerResolution"] as? String == "Roles authenticated active person with current applicable role",
              review["sourceAdmission"] as? String == "required before start and every request",
              isFalse(review["permissionsGranted"]), isFalse(review["runtimeEnrolled"]), isFalse(review["walletOrSafeApproval"]),
              integer(review["maximumCalls"]) == 62,
              integer(review["maximumDurationSeconds"]) == 300,
              integer(review["additionalSpendingUSD"]) == 0,
              let expiry = integer(review["expiresAt"]), expiry > now, expiry <= now + 300000,
              let serialized = try? JSONSerialization.data(withJSONObject: review, options: [.sortedKeys, .withoutEscapingSlashes]) else { return nil }
        let inner = SHA256.hash(data: serialized).map({ String(format: "%02x", $0) }).joined()
        let calculated = SHA256.hash(data: Data(("Bittrees native initial pairing scope review v1\n" + inner).utf8)).map({ String(format: "%02x", $0) }).joined()
        guard calculated == digest else { return nil }
        return InitialPairingReviewDisplay(reviewId: reviewId, digest: digest, principal: principal,
                                           keyFingerprint: local, rolesKeyFingerprint: source, expiresAt: expiry)
    }
}
