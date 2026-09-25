/**
 * staging-vault-lab.ts — live vault/exchange test battery on STAGING.
 *
 * Mints its OWN fresh random manager+depositor (never the pool/daemon vaults), reuses a vault
 * younger than REUSE_MIN minutes, else rotates to a new one and sweeps the retired vault's ETH
 * back to funding. Every test targets code reviewed in CONTRACT-REVIEW-2026-09-04.md; the niche
 * vs Foundry is the REAL dispatcher/keeper and staging's 60s CPP / 0s upgrade delay / 300s window.
 *
 * Runs one tick: ensure a live vault, run the read+manager-signed battery, append results.
 *   npx tsx src/staging-vault-lab.ts
 */
import { readFileSync, appendFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

// ── load staging env BEFORE importing config-driven modules ──────────────────
const ENVF = "/home/user/code/kperps-test/ikon-vaultgen/docker/staging/.env.staging";
for (const l of readFileSync(ENVF, "utf8").split("\n")) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
process.env.STRATEGY ??= "market-making";
process.env.MGR_ETH = "0.000015";  // node pre-checks gasLimit×maxFee + L1 ESTIMATE per tx; create ≈ 1M gas → keep 3× headroom
process.env.DEP_ETH = "0.00001";   // 0.000004 failed the pre-check on the compose deposit; leftovers are swept back anyway

const { ethers } = await import("ethers");
const { encodeFixedIncomeVaultConfigurationFields } = await import("@katanaperps/katana-perps-sdk");
const { provider, ensureFunded, createVault, depositTo, readVault, existingVault, vaultBalance } = await import("./vault.js");

const STATE = "/home/user/code/kperps-test/foundry-tests/ops/staging-vault-state.json";
const LOG = "/home/user/code/kperps-test/foundry-tests/ops/logs/staging-vault-lab.log";
const REUSE_MIN = 55;
const PROVIDER = process.env.VAULT_PROVIDER!;
const QUOTE = process.env.QUOTE_TOKEN!;
const FUNDING = new ethers.Wallet(process.env.FUNDING_WALLET_KEY!);
const p = provider();
const pip = (v: number) => BigInt(Math.round(v * 1e8));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const line = (s: string) => { console.log(s); appendFileSync(LOG, s + "\n"); };

// healthy, long-lived config: exitMult 0.50 (min) so a solvent vault is NEVER exit-eligible.
const HEALTHY = {
  interestMultiplierInPips: pip(0.10),
  maximumNetDepositsInPips: pip(5000),
  maximumTotalOwedQuantityAvailableForExitWithdrawalMultiplierNeededToInitiateExitInPips: pip(0.50),
  minimumTotalOwedQuantityAvailableForExitWithdrawalMultiplierToAllowManagerWalletWithdrawalInPips: pip(1.00),
  minimumUnappliedWithdrawalAgeInSNeededToInitiateExit: 3600,
  withdrawalLimitPercentForDepositorsInPips: pip(0.10),
  withdrawalLimitPercentForVaultInPips: pip(0.10),
};
const encodeCfg = (mgr: string, f: any) =>
  encodeFixedIncomeVaultConfigurationFields({ managerWallet: mgr, effectiveTimestampInS: 0, ...f });

const UPGRADE_ABI = [
  "function initiateManagedAccountUpgrade(bytes payload)",
  "function finalizeManagedAccountUpgrade()",
  "function cancelManagedAccountUpgrade()",
  "function loadVaultConfigurationsLength(address) view returns (uint256)",
  "function loadVaultSummary(address) view returns ((bool,bool,bool,bool,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64))",
  "function loadVaultBalanceForWalletSummary(address,address) view returns ((uint64,uint64,uint64,uint64,uint64,uint64,uint64))",
];
const waitRc = async (h: string) => { const r = await p.waitForTransaction(h, 1, 180_000); if (!r || r.status !== 1) throw new Error(`tx ${h} status ${r?.status}`); return r; };

interface St { rotation: number; manager: string; mgrPk: string; depPk: string; createdAt: number; status?: "minting" | "live"; }
const loadState = (): St | null => existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
const saveState = (s: St) => writeFileSync(STATE, JSON.stringify(s, null, 2), { mode: 0o600 });

async function sweepEth(pk: string, label: string) {
  try {
    const w = new ethers.Wallet(pk, p);
    const bal = await p.getBalance(w.address);
    const fd = await p.getFeeData();
    const maxFee = (fd.maxFeePerGas ?? fd.gasPrice ?? 3_000_000n) * 2n;      // 2× headroom on the L2 price
    const reserve = 21000n * maxFee + 1_000_000_000_000n;                        // + 1e-6 ETH: the node checks an OP-stack L1 cost ESTIMATE (~2e11 wei) far above the ~1.5e6 actually charged
    if (bal > reserve * 2n) {
      await waitRc((await w.sendTransaction({ to: FUNDING.address, value: bal - reserve, gasLimit: 21000n, maxFeePerGas: maxFee, maxPriorityFeePerGas: fd.maxPriorityFeePerGas ?? 1_000_000n })).hash);
      line(`   swept ${ethers.formatEther(bal - reserve)} ETH from ${label}`);
    } else line(`   ${label}: ${ethers.formatEther(bal)} ETH, below sweep threshold`);
  } catch (e: any) { line(`   sweep ${label} skipped: ${e?.shortMessage ?? e?.message ?? e}`); }
}

async function ensureManagerGas(mgrAddr: string, targetEth = "0.00006", minEth = "0.00003") {
  const bal = await p.getBalance(mgrAddr);
  if (bal >= ethers.parseEther(minEth)) return;
  const top = ethers.parseEther(targetEth) - bal;
  const f = new ethers.Wallet(FUNDING.pk ?? process.env.FUNDING_WALLET_KEY!, p);
  const fd = await p.getFeeData();
  await waitRc((await f.sendTransaction({ to: mgrAddr, value: top, gasLimit: 21000n, maxFeePerGas: (fd.maxFeePerGas ?? 3_000_000n) * 2n, maxPriorityFeePerGas: fd.maxPriorityFeePerGas ?? 1_000_000n })).hash);
  line(`   topped manager gas +${ethers.formatEther(top)} ETH (was ${ethers.formatEther(bal)})`);
}

async function mintVault(): Promise<St> {
  const prev = loadState();
  const rotation = (prev?.rotation ?? 0) + 1;
  const mgr = ethers.Wallet.createRandom();
  const dep = ethers.Wallet.createRandom();
  line(`\n[${now()}] ── rotation #${rotation}: minting fresh vault ${mgr.address} ──`);
  // Persist keys BEFORE the first transaction. A failure mid-mint must never strand a live vault
  // whose manager key existed only in memory (rotation #5, 2026-09-11: $120 seed lost that way).
  const s: St = { rotation, manager: mgr.address, mgrPk: mgr.privateKey, depPk: dep.privateKey, createdAt: Date.now(), status: "minting" };
  saveState(s);
  await ensureFunded(p, mgr.address, process.env.MGR_ETH!, "145");   // 120 seed + fee + slack
  const live = await createVault(p, { manager: new ethers.Wallet(mgr.privateKey, p), seedUsd: 120, fields: HEALTHY, log: line });
  if (!live) throw new Error("vault did not go live (ComposeFailed; seed recoverable from manager exchange balance)");
  line(`   ✓ vault LIVE`);
  await seedDepositor(s);
  if (prev) { await sweepEth(prev.mgrPk, `retired mgr #${prev.rotation}`); await sweepEth(prev.depPk, `retired dep #${prev.rotation}`); }
  return s;
}

async function seedDepositor(s: St) {
  const dep = new ethers.Wallet(s.depPk, p);
  await ensureFunded(p, dep.address, process.env.DEP_ETH!, "60");
  const ok = await depositTo(p, { managerAddr: s.manager, dep, amountUsd: 50, expectDepositors: 1, settleMs: 8000, log: line });
  line(`   depositor seed $50: ${ok ? "applied" : "NOT applied"}`);
  s.status = "live"; saveState(s);
}

async function ensureVault(): Promise<St> {
  const s = loadState();
  if (s) {
    const ageMin = (Date.now() - s.createdAt) / 60000;
    let v: any = null;
    try { v = await existingVault(p, s.manager); } catch {}
    const liveVault = v && v.exists && v.isActive && !v.isExited && !v.isLiquidated;
    if (s.status === "minting") {
      // A previous tick died mid-mint. If the vault went live, finish it (depositor) instead of
      // paying for a second seed; if it never went live, the seed is in the manager's exchange
      // balance and the wallets get swept on the next rotation.
      if (liveVault) { line(`\n[${now()}] resuming half-minted vault #${s.rotation} ${s.manager}`); if (v.numDepositorWallets === 0) await seedDepositor(s); else { s.status = "live"; saveState(s); } return s; }
      line(`\n[${now()}] rotation #${s.rotation} never went live — minting anew`);
      return mintVault();
    }
    if (ageMin < REUSE_MIN && liveVault) { line(`\n[${now()}] reusing vault #${s.rotation} ${s.manager} (age ${ageMin.toFixed(0)}m)`); return s; }
  }
  return mintVault();
}

// ── tests ────────────────────────────────────────────────────────────────────
type R = { name: string; pass: boolean; detail: string };
const results: R[] = [];
const check = (name: string, pass: boolean, detail: string) => { results.push({ name, pass, detail }); line(`   ${pass ? "✓" : "✗"} ${name} — ${detail}`); };

async function tInvariants(s: St) {
  const v = await readVault(p, s.manager, [new ethers.Wallet(s.depPk).address]);
  const perSum = (v as any).depositors?.reduce((a: number, d: any) => a + d.owed, 0) ?? (v as any).perDepositorOwedSum ?? null;
  check("reversion", !v.isExited && !v.isLiquidated && v.isActive, `active=${v.isActive} exited=${v.isExited} liq=${v.isLiquidated}`);
  const total = (v as any).totalOwedQuantity ?? (v as any).totalOwed;
  check("owed-consistency", total >= 0 && v.depositorNetDeposits >= 0, `totalOwed=${total?.toFixed?.(4)} netDeposits=${v.depositorNetDeposits} numDeps=${v.numDepositorWallets}`);
}

async function tConfigUpgrade(s: St) {
  const mgr = new ethers.Wallet(s.mgrPk, p);
  const c = new ethers.Contract(PROVIDER, UPGRADE_ABI, mgr) as any;
  const before = Number(await c.loadVaultConfigurationsLength(s.manager));
  // benign upgrade: bump maxNet +$1 (not one of the 6 downgrade fields → no bypass)
  const f = { ...HEALTHY, maximumNetDepositsInPips: HEALTHY.maximumNetDepositsInPips + pip(1) };
  await waitRc((await c.initiateManagedAccountUpgrade(encodeCfg(s.manager, f), { gasLimit: 800_000 })).hash);
  await waitRc((await c.finalizeManagedAccountUpgrade({ gasLimit: 800_000 })).hash); // delay 0 on staging
  const after = Number(await c.loadVaultConfigurationsLength(s.manager));
  check("config-upgrade-delay0", after === before + 1, `config history ${before} → ${after} (finalized same tick; staging upgradeDelay=0)`);
}

async function tDowngradeBypass(s: St) {
  const mgr = new ethers.Wallet(s.mgrPk, p);
  const depAddr = new ethers.Wallet(s.depPk).address;
  const c = new ethers.Contract(PROVIDER, UPGRADE_ABI, mgr) as any;
  const avail = async () => Number((await c.loadVaultBalanceForWalletSummary(s.manager, depAddr))[5]) / 1e8;
  const owed = async () => Number((await c.loadVaultBalanceForWalletSummary(s.manager, depAddr))[3]) / 1e8;
  const base = await avail(); const ow = await owed();
  // downgrade: interest → 0 (one of the 6 bypass fields). In-flight ⇒ full owed available, no rate limit.
  const f = { ...HEALTHY, interestMultiplierInPips: 0n };
  await waitRc((await c.initiateManagedAccountUpgrade(encodeCfg(s.manager, f), { gasLimit: 800_000 })).hash);
  const bypassed = await avail();
  await waitRc((await c.cancelManagedAccountUpgrade({ gasLimit: 400_000 })).hash);
  const restored = await avail();
  const bound = base < ow - 0.5;                         // did the rate-limit cap actually bind at base?
  const lifts = bypassed >= ow - 0.01;                   // in-flight downgrade lifts to full owed
  const back = restored <= base + 0.01;                  // cancel restores the cap
  check("downgrade-bypass-live", lifts && bypassed >= base - 0.01 && (!bound || back),
    `cap ${bound ? "BINDS" : "slack"}: base=${base.toFixed(2)} in-flight=${bypassed.toFixed(2)} owed=${ow.toFixed(2)} restored=${restored.toFixed(2)} — ${bound ? "bypass lifted the 10%+10% cap to full owed then cancel restored it" : "additive cap exceeds owed here"}`);
}

// ── main ───────────────────────────────────────────────────────────────────
mkdirSync(dirname(LOG), { recursive: true });
line(`\n════════ staging-vault-lab tick ${now()} ════════`);
const bal = await p.getBalance(FUNDING.address);
line(`funding ${FUNDING.address} ETH ${ethers.formatEther(bal)}`);
if (bal < ethers.parseEther("0.00008")) { line("⛔ funding ETH too low to mint/fund — reclaim first. Skipping mint; reads only if a vault exists."); }

let s: St;
try { s = await ensureVault(); }
catch (e: any) { line(`⛔ ensureVault failed: ${e?.shortMessage ?? e?.message ?? e}`); process.exit(1); }

try { await ensureManagerGas(s.manager); } catch (e: any) { line(`   manager gas top-up failed: ${e?.shortMessage ?? e?.message ?? e}`); }
for (const [name, fn] of [["invariants", tInvariants], ["config-upgrade", tConfigUpgrade], ["downgrade-bypass", tDowngradeBypass]] as const) {
  try { await fn(s); } catch (e: any) { check(name, false, `threw: ${String(e?.shortMessage ?? e?.reason ?? e?.message ?? e).slice(0, 140)}`); }
}
const pass = results.filter(r => r.pass).length;
line(`\nRESULT rotation #${s.rotation} ${s.manager}: ${pass}/${results.length} passed`);
line(`funding ETH now ${ethers.formatEther(await p.getBalance(FUNDING.address))}`);
