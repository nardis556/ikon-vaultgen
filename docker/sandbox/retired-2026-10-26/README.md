# Sandbox demo vaults retired 2026-10-26

Sandbox moved to a new FixedIncomeVaultProvider_v1 `0x8E670De99eE17bf877923A234E9A12d1e918fb7A` (signed creation,
deployed 2026-10-26 21:50 UTC, reported by `GET /exchange`). These dirs belong to the OLD provider
`0x9304FEeCa70694B5d9BeFEB5577EF6182f158CeB`; each `.env.STRATEGY` here pins it. Keys (.env.MANAGER / .env.DEPOSITORS),
state and on-chain funds are untouched. Daemons stopped and all 95 resting manager orders cancelled on 2026-10-26.

Old managers: ema-trend `0x9501d136A6934454102B890863393928dA0eE6fc`, rsi-pullback `0x0C1D0bc779bB16618b20E13cf2F5B13b6aA1e17c`,
macd-crossover `0x98fB4d78E2898a16089829BB0a94586a217c431B`, donchian-breakout `0xF4EEcD8a3b3ca3c41A2931E4C875AA5BeB99b892`,
market-making `0xd7D3dF3486659DA565F89e74cf3Ac7faF1ee40d6`, bollinger-fade `0xB6C029d0F75969d95e7a5f81e583CDaEB731B86a`.
The vaultgen funding wallet changed on the same day (dedicated sandbox vaultgen wallet); the shared loadgen funding
wallet `0x1A73f787…` was the one these vaults used.
