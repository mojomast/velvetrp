# Vendor commerce

Vendor commerce is available to adventure turns only through server-issued exact candidates.

## Setup

An owner or GM associates an existing campaign NPC with an existing shop using `associateNpcShop(principalId, campaignId, npcId, shopId)`. The repository rejects cross-campaign records and conflicting reassociation. `getNpcShop` is membership-gated and returns an association only while both records remain valid in that campaign.

Shops accept paid sales only for stock configured with `setShopBuyPolicy(principalId, campaignId, shopId, stockId, payoutUnitMinor)`. A free gift can target an item the shop already stocks. These are deterministic repository APIs; no provider can configure vendors, stock, prices, or acceptance policy.

## Adventure safety

`exact_vendor_commerce.select` accepts only a candidate ID and digest. The server owns the vendor, shop, item, inventory entry, quantity, currency, quote, price, revisions, recipient, and outcome.

Candidates are generated only when the associated NPC is present in the active attached session, at the controlled actor's current location, and that location is public or discovered by the actor. Unknown, hidden, absent, remote, cross-campaign, unaffordable, out-of-stock, full-inventory, and equipped-item cases fail closed.

Every buy, sell, or gift requires controller confirmation showing the vendor, shop, item, quantity, price, and inventory/wallet consequence. Execution revalidates visibility, quote expiry, actor revision, stock, wallet, capacity, source entry, equipment state, and buy policy inside the atomic transaction.

Buying uses the existing immutable shop quote and purchase command. Selling and giving use an immutable vendor sale quote and `sell_to_shop`; the command removes the exact unequipped source quantity, increments shop stock, credits the wallet for a sale (zero for a gift), advances the actor economy revision once, and emits an idempotent receipt.

Public receipts contain labels, quantity, debit or credit, safe wallet balances, revisions, and time. They omit NPC, shop, item, entry, actor, provider, candidate, quote, pack, and digest identities. Adventure narration is composed from those receipts.
