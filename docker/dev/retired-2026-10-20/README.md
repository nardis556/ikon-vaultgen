# Retired dev vaults (providers before 2026-10-20)

These strategy dirs drove the dev vaults on the OLD providers — FIV `0x46b4C417…`, PSV `0xC2AbBCB4…`.
`GET /exchange` has listed the new signed providers (FIV `0xC1e94AD0…`, PSV `0x7C730959…`) since
2026-10-20, so the vaults were re-created there in fresh dirs one level up.

Each dir still holds its `.env.MANAGER` / `.env.DEPOSITORS` (gitignored keys): the old vaults and
their depositors' funds are untouched and recoverable from here. Daemons were stopped and every
resting manager order cancelled on 2026-10-21. To run one again, start it from this folder
(`../.env.dev` is symlinked; each `.env.STRATEGY` pins its OLD provider, so the new one in
`.env.dev` never applies here); the PSV composes mount `../../../strategies`, which resolves one
level too high from here — drop that mount (the image ships the strategies). The two macd dirs
still hold small positions (ETH ≈0.1 + SOL 2.36 each).
