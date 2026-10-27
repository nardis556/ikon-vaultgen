# Staging demo vaults retired 2026-10-26

Staging moved to a new FixedIncomeVaultProvider_v1 `0x6B1cd16C903Eb613E5de94e3cD3E119c01C391d1` (signed creation,
deployed 2026-10-26 20:06 UTC, reported by `GET /exchange`). These dirs belong to the OLD provider
`0x85Ea9016acdEc997338F92B3E1256E9ae4aC9411` (deployed 2026-07-31; `isAddManagedAccountEnabled() = false`).

Wallets are deterministic: POOL_MNEMONIC (../.env.staging) + STRATEGY + INSTANCE=staging (index 0 = manager,
1..16 = depositors). Keys and state are untouched; each `.env.STRATEGY` here pins VAULT_PROVIDER to the old provider.

Old vaults (provider 0x85Ea9016…): ema-trend `0xb337f09cC42AF86a128962271aA814d36339a2F1`,
rsi-pullback `0x01E923dd907868348c52797b9B9ef04E69e47ed8`, macd-crossover `0xA97FEEc9abCe45D75052560d4D79e9a391bA45b3`,
donchian-breakout `0xfa16BCdBcccb51071FC51a332c96000Da7ABDc56`; market-making part-seeded, bollinger-fade and
gold-trend never provisioned (2026-10-15/16 notes). psv-ema-trend: staging has no PSV provider.
