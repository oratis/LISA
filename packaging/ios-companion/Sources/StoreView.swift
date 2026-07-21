import SwiftUI
import StoreKit

/// Consumable credit packs (PLAN_ACCOUNTS_BILLING B5).
///
/// Flow: StoreKit 2 purchase → send the transaction's JWS to the server
/// (`POST /api/billing/iap`) → the server verifies the Apple signature chain,
/// dedupes by transactionId, credits the signed-in account → ONLY THEN
/// `Transaction.finish()`. If we crash before the server answers, StoreKit
/// re-delivers the unfinished transaction via `Transaction.updates` and the
/// server-side dedup makes the replay safe.
@MainActor
final class CreditsStore: ObservableObject {
    static let shared = CreditsStore()
    static let productIDs = [
        "ai.meetlisa.main.credits.5",
        "ai.meetlisa.main.credits.10",
        "ai.meetlisa.main.credits.20",
    ]

    @Published var products: [Product] = []
    @Published var busy = false
    @Published var message: String?
    private var updatesTask: Task<Void, Never>?

    /// Start the unfinished-transaction listener once per launch (App.swift).
    func start(app: AppState) {
        guard updatesTask == nil else { return }
        updatesTask = Task { [weak self, weak app] in
            for await update in StoreKit.Transaction.updates {
                guard let self, let app else { return }
                await self.credit(update, app: app)
            }
        }
    }

    func loadProducts() async {
        guard products.isEmpty else { return }
        let loaded = (try? await Product.products(for: Self.productIDs)) ?? []
        products = loaded.sorted { $0.price < $1.price }
    }

    func purchase(_ product: Product, app: AppState) async {
        busy = true
        defer { busy = false }
        message = nil
        do {
            switch try await product.purchase() {
            case .success(let verification):
                await credit(verification, app: app)
            case .userCancelled:
                break
            case .pending:
                message = "Purchase is pending approval."
            @unknown default:
                break
            }
        } catch {
            message = "Purchase failed — please try again."
        }
    }

    /// Server-credit a verified transaction, then finish it.
    private func credit(_ verification: VerificationResult<StoreKit.Transaction>, app: AppState) async {
        guard case .verified(let tx) = verification else { return }
        do {
            let r = try await app.client.iapSubmit(jws: verification.jwsRepresentation)
            if r.ok {
                await tx.finish()
                message = "Credits added."
                await app.refreshAccount()
            } else {
                message = "Couldn't credit the purchase (\(r.error ?? "error"))."
            }
        } catch {
            // Leave the transaction unfinished — StoreKit re-delivers it and the
            // server dedup makes the retry safe.
            message = "Couldn't reach the server — the purchase will be credited automatically."
        }
    }

    func restore() async {
        try? await AppStore.sync()
    }
}

/// The paywall sheet: three packs, restore, and the tier explainer.
struct PaywallSheet: View {
    @EnvironmentObject var app: AppState
    @StateObject private var store = CreditsStore.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if store.products.isEmpty {
                        HStack { ProgressView(); Text("Loading packs…").foregroundStyle(.secondary) }
                    }
                    ForEach(store.products, id: \.id) { product in
                        Button {
                            Task { await store.purchase(product, app: app) }
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(product.displayName.isEmpty ? product.id : product.displayName)
                                    Text(bonusLabel(product.id))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(product.displayPrice).bold()
                            }
                        }
                        .disabled(store.busy)
                    }
                } header: {
                    Text("Credit packs")
                } footer: {
                    Text("Credits never expire and roam with your account. Any purchase also raises your free 12-hour session allowance for 30 days ($4.99+ → $10, $19.99+ → $20). Premium models draw on credits only.")
                }

                Section {
                    Button("Restore purchases") { Task { await store.restore() } }
                }

                if let msg = store.message {
                    Section { Text(msg).font(.caption).foregroundStyle(.secondary) }
                }
            }
            .consoleBackground()
            .navigationTitle("Add credits")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
            .task { await store.loadProducts() }
        }
        .preferredColorScheme(.dark)
    }

    private func bonusLabel(_ id: String) -> String {
        switch id {
        case "ai.meetlisa.main.credits.5": return "$5.00 in credits · Tier 1 boost"
        case "ai.meetlisa.main.credits.10": return "$10.50 in credits (+5%) · Tier 1 boost"
        case "ai.meetlisa.main.credits.20": return "$22.00 in credits (+10%) · Tier 2 boost"
        default: return ""
        }
    }
}
