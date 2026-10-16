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

    // MARK: Arc business (LOCAL_FIXTURE)

    static func capabilities(_ on: Bool = true) -> BusinessCapabilities {
        let f = BusinessFeature(enabled: on, reason: on ? nil : "Invoices need SYNQ_PAY_LINK_KEY on the server.")
        return BusinessCapabilities(network: "Arc testnet", chainId: 5042002, business: "Synq demo business",
                                    features: Dictionary(uniqueKeysWithValues: BusinessFeatureKind.allCases.map {
                                        ($0.rawValue, $0 == .invoices ? f : BusinessFeature(enabled: true, reason: nil))
                                    }))
    }

    static let dealText = "Logo and brand kit for Sarah: 300 USDC total. 150 when the logo concepts are delivered, 150 for the final brand kit, within 14 days."

    static let deal = DealDraft(status: "DRAFTED", dealId: "deal_7f3a91c2", title: "Logo and brand kit", total: "300",
                                symbol: "USDC",
                                milestones: [DealMilestone(title: "Logo concepts delivered", amount: "150", due: "2026-10-30"),
                                             DealMilestone(title: "Final brand kit", amount: "150", due: "2026-10-30")],
                                client: "Kaushikh", freelancer: "Sarah", arbiter: "Arjun",
                                ambiguities: ["No message names the file formats for the brand kit."],
                                reviewUrl: "https://synq.example/deal/deal_7f3a91c2?t=1790000000.0.abc", reason: nil,
                                network: "Arc testnet")

    static func invoice(_ status: String) -> BusinessInvoice {
        BusinessInvoice(invoiceId: "inv_0f3a9c2e11", number: "SYNQ-0F3A9C", status: status, payer: "Priya",
                        description: "Logo", total: "120.00", symbol: "USDC", dueDate: "2026-10-30",
                        issuer: "Synq demo business", payTo: "0x4444444444444444444444444444444444444444",
                        issueUrl: "https://synq.example/invoice/inv_0f3a9c2e11?t=abc",
                        payUrl: status == "DRAFT" ? nil : "https://synq.example/pay/inv_0f3a9c2e11.1.1790000000.mac0123456789",
                        network: "Arc testnet")
    }

    static let team = TeamResult(
        status: "ANSWERED", runId: "team_1760600000",
        sections: [
            TeamSection(persona: "CFO", label: "CFO", stance: "PAY",
                        text: "Pay: the vault holds 0.039 USDC, and this 0.002 USDC payout fits inside the 0.004 USDC left in today's vault window.",
                        evidence: ["vault balance", "invoice INV-0102"]),
            TeamSection(persona: "RISK", label: "Risk", stance: "CLEAR",
                        text: "Sarah's payout address is on the vault allowlist and matches the vendor master. Wallet screening is unavailable on this server.",
                        evidence: ["vendor master"]),
        ],
        decision: TeamDecision(status: "NOT_SUBMITTED", outcome: nil,
                               reasons: ["no active mandate or treasury wallet in the WorldSnapshot"]),
        riskCase: nil, unavailable: ["WALLET_SCREENING NEEDS_CREDENTIALS (risk.screenCounterparty)"],
        approvalUrl: nil, answer: nil, readOnly: true, network: "Arc testnet")

    static let treasury = TreasuryView(
        network: "Arc testnet", blockNumber: "18204417", observedAt: 1_760_600_000,
        accounts: [TreasuryAccount(label: "Governed vault", address: "0x4444444444444444444444444444444444444444",
                                   usdc: "0.039", explorer: nil),
                   TreasuryAccount(label: "Owner", address: "0x6666666666666666666666666666666666666666",
                                   usdc: "24.408057", explorer: nil)],
        vaultPolicy: VaultPolicyView(perPaymentCap: "0.01", windowCap: "0.02", remaining: "0.004", paused: false),
        earn: [EarnVaultView(name: "Circle Earn USDC vault", address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                             underlyingOk: true, totalAssets: "102745.275976", apy: nil, note: "APY needs Circle App Kit; not fetched"),
               EarnVaultView(name: "Circle Earn test vault (mock Morpho)", address: "0x8888888888888888888888888888888888888888",
                             underlyingOk: true, totalAssets: "331.0246", apy: nil, note: "Test vault: figures are illustrative")],
        usyc: UsycEligibility(wallet: "0x4444444444444444444444444444444444444444", status: "INELIGIBLE",
                              explanation: "Not allowlisted for USYC Teller.deposit. USYC is a permissioned fund; Circle must allowlist the address. Synq will not attempt it."))

    static let split = SplitPreview(
        label: "PREVIEW", amount: "1500", symbol: "USDC",
        headline: "1500.00 USDC received: 375.00 tax estimate reserved, 1125.00 free cash",
        legs: [SplitLeg(purpose: "TAX_ESTIMATE", kind: "RESERVE", label: "Tax reserve", amount: "375.00",
                        basis: "25% of the gross receipt, held back; not a tax payment"),
               SplitLeg(purpose: "UNALLOCATED", kind: "FREE_CASH", label: "Free cash", amount: "1125.00",
                        basis: "Stays in the governed vault")],
        summary: ["taxReserve": "375.00", "freeCash": "1125.00"],
        forecast: [ForecastPoint(days: 30, committed: "1125.039", expected: "1125.039", lowPoint: "1125.039"),
                   ForecastPoint(days: 60, committed: "1125.039", expected: "1125.039", lowPoint: "1125.039"),
                   ForecastPoint(days: 90, committed: "1125.039", expected: "1125.039", lowPoint: "1125.039")],
        policy: SplitPolicyView(taxReserveBps: 2500, operatingFloor: "100", horizonDays: 30),
        notes: ["Preview only: nothing is reserved or sent."])

    static let vendors = [
        BusinessVendor(vendorId: "sarah", name: "Sarah", kind: "CONTRACTOR", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                       verified: true, source: "vault allowlist"),
        BusinessVendor(vendorId: "kite", name: "Kite Studio", kind: "VENDOR", address: "0x1111111111111111111111111111111111111111",
                       verified: true, source: "vault allowlist"),
    ]
}
