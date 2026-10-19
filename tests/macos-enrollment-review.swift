import Foundation

@main struct CheckEnrollmentReview {
    static func main() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let proposal = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        precondition(EnrollmentReviewDisplay.parse(proposal) != nil, "Node proposal digest must match native Swift")
        var changed = proposal
        var review = proposal["review"] as! [String: Any]
        review["deviceId"] = UUID().uuidString.lowercased()
        changed["review"] = review
        precondition(EnrollmentReviewDisplay.parse(changed) == nil, "Changed device must invalidate displayed approval")
        changed = proposal
        var disclosure = proposal["disclosure"] as! [String: Any]
        disclosure["hosts"] = ["other.example"]
        changed["disclosure"] = disclosure
        precondition(EnrollmentReviewDisplay.parse(changed) == nil, "Changed destination must invalidate approval")
        changed = proposal
        changed["digest"] = String(repeating: "0", count: 64)
        precondition(EnrollmentReviewDisplay.parse(changed) == nil, "Wrong digest must fail")
        print("Native review accepts Node digest and rejects changed identity, host and digest")
    }
}
