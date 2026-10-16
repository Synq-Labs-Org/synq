import Foundation

// Sample data for the design previews (LOCAL_FIXTURE: never shown in the app).

enum Samples {
    static let members = [
        FundMember(name: "Kaushikh", principalId: "p1", memberId: "m1", activated: true, signedSetup: true),
        FundMember(name: "Priya", principalId: "p2", memberId: "m2", activated: true, signedSetup: true),
        FundMember(name: "Arjun", principalId: "p3", memberId: "m3", activated: true, signedSetup: true),
        FundMember(name: "Meera", principalId: "p4", memberId: "m4", activated: false, signedSetup: false),
    ]

    static func proposal(_ state: String, counted: Int, amount: String = "26.99", recipient: String = "Synq Travel") -> FundProposal {
        FundProposal(intentHash: "0x7a3f" + String(repeating: "0", count: 58) + (state == "PAID" ? "01" : "02"),
                     state: state, amount: amount, symbol: "AUSD", recipient: recipient, sender: "Priya",
                     approvals: FundApprovals(counted: counted, required: 2,
                                              names: Array(["Priya", "Arjun"].prefix(counted))),
                     transactionHash: state == "PAID" ? "0x9c1e44b2d0" + String(repeating: "a", count: 54) : nil,
                     explorer: state == "PAID" ? "https://testnet.monadexplorer.com/tx/0x9c1e" : nil,
                     createdAt: 1_760_000_000)
    }

    static func fund(_ state: String, balance: String? = "255.00", proposals: [FundProposal] = []) -> FundView {
        let m = state == "FORMING" ? Array(members.prefix(2)) : members
        return FundView(fundId: "fnd_3a1fc2e90b7d4410aa21", name: "Goa crew", state: state, error: nil,
                        createdAt: 1_760_000_000, members: m, minMembers: 2, maxMembers: 8, threshold: 2,
                        group: state == "FORMING" ? nil : FundGroup(chainGroupId: "0x" + String(repeating: "ab", count: 32),
                                                                    account: "0x1234"),
                        setup: state == "SETUP" ? FundSetup(signed: 1, required: 2) : nil,
                        treasury: state == "ACTIVE" ? FundTreasury(balance: balance ?? "0", symbol: "AUSD") : nil,
                        recipients: [FundRecipient(name: "Priya", recipientId: "r1"),
                                     FundRecipient(name: "Synq Travel", recipientId: "r2")],
                        proposals: proposals, canRequestTestFunds: true, maxPayment: "500",
                        network: nil, chainId: nil)
    }

    static let activeFund = fund("ACTIVE", proposals: [proposal("PENDING", counted: 1, amount: "254.30"),
                                                         proposal("PAID", counted: 2, amount: "26.99", recipient: "Priya")])

    static func option(_ id: String, _ total: String, votes: Int, refundable: Bool = false,
                       outbound: (String, String), inbound: (String, String)?) -> TripOptionView {
        var legs = [TripLeg(origin: "DEL", destination: "GOI", departAt: "2026-12-01T\(outbound.0):00",
                            arriveAt: "2026-12-01T\(outbound.1):00", date: nil, flightNumber: nil, stops: 0, duration: nil)]
        if let inbound {
            legs.append(TripLeg(origin: "GOI", destination: "DEL", departAt: "2026-12-05T\(inbound.0):00",
                                arriveAt: "2026-12-05T\(inbound.1):00", date: nil, flightNumber: nil, stops: 1, duration: nil))
        }
        return TripOptionView(optionId: id, title: "Duffel Airways ZZ \(id.count * 100 + votes)",
                              detail: "DEL → GOI · nonstop · economy", total: total, currency: "USD",
                              refundable: refundable, votes: votes, legs: legs)
    }

    static func trip(_ state: String, returning: Bool = true) -> TripView {
        let options = [
            option("a1", "254.30", votes: 3, outbound: ("07:10", "09:45"), inbound: returning ? ("18:40", "23:05") : nil),
            option("b22", "271.80", votes: 1, refundable: true, outbound: ("11:25", "13:55"), inbound: returning ? ("09:15", "13:30") : nil),
            option("c333", "298.10", votes: 0, outbound: ("16:05", "18:40"), inbound: returning ? ("20:30", "22:55") : nil),
        ]
        return TripView(tripId: "trp_0123456789abcdef", kind: "FLIGHT", title: "DEL → GOI · 2026-12-01",
                        origin: "DEL", destination: "GOI", departureDate: "2026-12-01",
                        returnDate: returning ? "2026-12-05" : nil, travelers: 3, query: nil, maxPrice: nil,
                        state: state, options: options, voteCount: 4, leading: "a1", myVote: "a1",
                        chosen: state == "VOTING" ? nil : "a1",
                        payment: state == "VOTING" ? nil : TripPayment(amount: "254.30", intentHash: nil),
                        booking: state == "BOOKED" ? TripBooking(reference: "ZZ8K2Q") : nil, error: nil,
                        label: "Duffel test mode · no real ticket is issued",
                        payTo: TripPayTo(recipientId: "r2", label: "Synq Travel"))
    }

    static func gift(_ state: String) -> TripView {
        let options = [
            TripOptionView(optionId: "g1", title: "Car lover's coffee mug", detail: "Amazon · 2-day delivery",
                           total: "18.99", currency: "USD", refundable: true, votes: 2),
            TripOptionView(optionId: "g2", title: "Classic car poster set", detail: "Etsy", total: "32.00",
                           currency: "USD", refundable: false, votes: 1),
        ]
        return TripView(tripId: "trp_fedcba9876543210", kind: "GIFT", title: "Gift: car lovers", origin: nil,
                        destination: nil, departureDate: nil, returnDate: nil, travelers: nil, query: "car lovers",
                        maxPrice: "40", state: state, options: options, voteCount: 3, leading: "g1", myVote: nil,
                        chosen: state == "VOTING" ? nil : "g1",
                        payment: state == "VOTING" ? nil : TripPayment(amount: "18.99", intentHash: nil),
                        booking: nil, error: nil, label: "Live prices · sandbox card, no real order",
                        payTo: TripPayTo(recipientId: "r2", label: "Synq Gifts"))
    }

    static let plan = FlightPlan(origin: "DEL", destination: "GOI", departureDate: "2026-12-01", returnDate: "2026-12-05",
                                 travelers: 3, originLabel: "Delhi", destinationLabel: "Goa", cabin: nil)
}
