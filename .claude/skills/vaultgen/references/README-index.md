# vaultgen references — index

| File | Read it when you need to know… |
|---|---|
| `architecture.md` | What vaultgen is, the six MODEs, what every `src/*.ts` module does, the provisioning flow (funding → wallets → signed creation via the local deposit adapter → deposits → association → naming), the animate loop (signals, skewed ladder incl. "held inside the book", taker trades, churn, RWA session gating), FIV vs PSV code paths, on-chain vs REST reads, and where the README disagrees with the code. |
| `config.md` | Every environment variable (default, required, meaning, modes), compose/env-file precedence (`../.env.<env>` → `../.env` → `.env.STRATEGY` → `environment:` → `run -e`), which file holds what (by variable name only), current non-secret per-env addresses read from `GET /exchange`, and the strategy JSON schema with a real example. |
| `operations.md` | How to check status and logs, tell whether a daemon is quoting, start/stop/restart/recreate safely (EXECUTE pass-through!), provision/associate/fund/rename non-interactively, cancel a manager's orders (`../scripts/cancel-manager-orders.sh`), add a strategy dir, retire a set and re-create it on a new provider, build the image, and use the RPC access key in header mode. |
| `gotchas.md` | 37 known pitfalls as symptom → cause → fix → where, starting with deployment state: dev deposits failing on the old adapter after 2026-11-13 (fixed 2026-11-17), the deposit re-send fix not deployed, env/image changes needing a recreate, provisioning refused by the provider drift check, EISDIR, nonce collisions, MGR_ETH/DEP_ETH burn, self-trade prevention, stale orders pulling the ladder, the staging API secret mix-up, the $110 seed floor. |

State as of 2026-11-17: 11 `vgdev-*`, 7 `vgstg-*`, 6 `vg-*` daemons on `ikon-vaultgen:local` (built 2026-10-21 =
HEAD `97d646c` minus `src/vault.ts:371-378`). Re-verify anything time-sensitive (providers, adapter, funding
balances, container state) before acting — `GET /exchange` and `docker ps` are the authorities.
