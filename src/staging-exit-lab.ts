/**
 * staging-exit-lab.ts — LIVE managed-account EXIT lifecycle on STAGING, one full cycle per run.
 *
 * Mints a FRESH exit-eligible vault (its own random manager+depositor, never the daemon vaults),
 * then in ONE tick (staging CPP is 60s): snapshot EAV → manager exitWallet → wait CPP →
 * withdrawExit(depositor) + withdrawExit(manager) → conservation check (recovered ≈ EAV_pre) →
 * sweep both wallets back to funding. Rate-limited to >=RATE_MIN minutes between mints.
 *
 * Exit-eligibility while SOLVENT: exitMult 2.0 (max) + depositor-heavy deposit ⇒ EAV < owed×2
 * (FixedIncomeVaultProvider_v1.exitWallet EAV trigger). All calls manager/depositor-signed; no
 * admin/dispatcher needed. Log: foundry-tests/ops/logs/staging-exit-lab.log
 *   npx tsx src/staging-exit-lab.ts
 */
import { readFileSync, appendFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const ENVF = "/home/user/code/kperps-test/ikon-vaultgen/docker/staging/.env.staging";
for (const l of readFileSync(ENVF, "utf8").split("\n")) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
process.env.STRATEGY ??= "market-making";
process.env.MGR_ETH = "0.00003";
process.env.DEP_ETH = "0.00002";

const { ethers } = await import("ethers");
const { provider, ensureFunded, createVault, depositTo } = await import("./vault.js");

const STATE = "/home/user/code/kperps-test/foundry-tests/ops/staging-exit-state.json";
const LOG = "/home/user/code/kperps-test/foundry-tests/ops/logs/staging-exit-lab.log";
const RATE_MIN = Number(process.env.RATE_MIN ?? 115);            // >= this many minutes between exit cycles
const SEED = 120, DEP = 250;                                       // EAV≈360 < owed≈250×2 ⇒ exit-eligible, solvent
const CPP_MARGIN_S = 30;
const PROVIDER = process.env.VAULT_PROVIDER!, EXCHANGE = process.env.EXCHANGE_CONTRACT!, QUOTE = process.env.QUOTE_TOKEN!;
const FUNDING = new ethers.Wallet(process.env.FUNDING_WALLET_KEY!);
const p = provider();
const pip = (v: number) => BigInt(Math.round(v * 1e8));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const line = (s: string) => { console.log(s); appendFileSync(LOG, s + "\n"); };
const waitRc = async (h: string) => { const r = await p.waitForTransaction(h, 1, 180_000); if (!r || r.status !== 1) throw new Error(`tx ${h} status ${r?.status}`); return r; };

const EXIT_FIELDS = {
  interestMultiplierInPips: pip(0.10),
  maximumNetDepositsInPips: pip(5000),
  maximumTotalOwedQuantityAvailableForExitWithdrawalMultiplierNeededToInitiateExitInPips: pip(2.00), // MAX
  minimumTotalOwedQuantityAvailableForExitWithdrawalMultiplierToAllowManagerWalletWithdrawalInPips: pip(1.00),
  minimumUnappliedWithdrawalAgeInSNeededToInitiateExit: 3600,
  withdrawalLimitPercentForDepositorsInPips: pip(1.00),
  withdrawalLimitPercentForVaultInPips: pip(1.00),
};
const PROV_ABI = [
  "function exitWallet(address managerWallet)",
  "function withdrawExit(address managerWallet, address depositorWallet)",
  "function loadVaultSummary(address) view returns ((bool,bool,bool,bool,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64))",
];
const EX_ABI = ["function loadQuoteQuantityAvailableForExitWithdrawal(address) view returns (int64)", "function chainPropagationPeriodInS() view returns (uint256)"];
const usdcRead = new ethers.Contract(QUOTE, ["function balanceOf(address) view returns (uint256)"], p);

async function sweepAll(pk: string, label: string) {
  try {
    const w = new ethers.Wallet(pk, p);
    const vb = new ethers.Contract(QUOTE, ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"], w) as any;
    const u = await vb.balanceOf(w.address);
    const fd = await p.getFeeData(); const maxFee = (fd.maxFeePerGas ?? 3_000_000n) * 2n;
    if (u > 0n) { await waitRc((await vb.transfer(FUNDING.address, u, { gasLimit: 80_000n, maxFeePerGas: maxFee })).hash); line(`   swept ${ethers.formatUnits(u, 6)} vbUSDC from ${label}`); }
    const bal = await p.getBalance(w.address); const reserve = 21000n * maxFee + 1_000_000_000_000n;
    if (bal > reserve * 2n) { await waitRc((await w.sendTransaction({ to: FUNDING.address, value: bal - reserve, gasLimit: 21000n, maxFeePerGas: maxFee, maxPriorityFeePerGas: fd.maxPriorityFeePerGas ?? 1_000_000n })).hash); line(`   swept ${ethers.formatEther(bal - reserve)} ETH from ${label}`); }
  } catch (e: any) { line(`   sweep ${label} skipped: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 80)}`); }
}

async function topUpGas(addr: string, targetEth = "0.00006") {
  const bal = await p.getBalance(addr);
  if (bal >= ethers.parseEther(targetEth)) return;
  const f = new ethers.Wallet(process.env.FUNDING_WALLET_KEY!, p);
  const fd = await p.getFeeData();
  await waitRc((await f.sendTransaction({ to: addr, value: ethers.parseEther(targetEth) - bal, gasLimit: 21000n, maxFeePerGas: (fd.maxFeePerGas ?? 3_000_000n) * 2n, maxPriorityFeePerGas: fd.maxPriorityFeePerGas ?? 1_000_000n })).hash);
  line(`   topped gas ${addr.slice(0,10)}… → ${targetEth} ETH`);
}

mkdirSync(dirname(LOG), { recursive: true });
line(`\n════════ staging-exit-lab ${now()} ════════`);
const st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { run: 0, lastMintAt: 0 };
const sinceMin = (Date.now() - (st.lastMintAt ?? 0)) / 60000;
if (sinceMin < RATE_MIN) { line(`rate-limited: ${sinceMin.toFixed(0)}min since last exit cycle (< ${RATE_MIN}min). Holding.`); process.exit(0); }
const fbal = await p.getBalance(FUNDING.address);
line(`funding ${FUNDING.address} ETH ${ethers.formatEther(fbal)}`);
if (fbal < ethers.parseEther("0.0001")) { line("⛔ funding ETH too low for a full exit cycle. Stopping."); process.exit(1); }

const ex = new ethers.Contract(EXCHANGE, EX_ABI, p) as any;
const provRead = new ethers.Contract(PROVIDER, PROV_ABI, p) as any;
let run: number, mgr: any, dep: any, eavPre: number, cppS = Number(await ex.chainPropagationPeriodInS());

// Resume a prior run that exited but never finished withdrawExit (e.g. depositor ran out of gas).
let resume = false;
if (st.phase && st.phase !== "done" && st.mgrPk && st.depPk) {
  try { const sm = await provRead.loadVaultSummary(st.manager); if (sm[1] && !sm[2]) { resume = true; } } catch {}
}
if (resume) {
  run = st.run; mgr = new ethers.Wallet(st.mgrPk, p); dep = new ethers.Wallet(st.depPk, p);
  eavPre = st.eavPre ?? Number(await ex.loadQuoteQuantityAvailableForExitWithdrawal(st.manager)) / 1e8;
  line(`\n[${now()}] ── RESUMING exit run #${run}: ${st.manager} already exited; finishing withdrawExit ──`);
} else {
  run = (st.run ?? 0) + 1;
  const mw = ethers.Wallet.createRandom(), dw = ethers.Wallet.createRandom();
  mgr = new ethers.Wallet(mw.privateKey, p); dep = new ethers.Wallet(dw.privateKey, p);
  writeFileSync(STATE, JSON.stringify({ run, manager: mgr.address, mgrPk: mgr.privateKey, depPk: dep.privateKey, lastMintAt: Date.now(), phase: "minting" }, null, 2), { mode: 0o600 });
  line(`\n[${now()}] ── exit run #${run}: fresh vault ${mgr.address} (seed $${SEED}, dep $${DEP}, exitMult 2.0) ──`);
  await ensureFunded(p, mgr.address, process.env.MGR_ETH!, String(SEED + 25));
  const live = await createVault(p, { manager: mgr, seedUsd: SEED, fields: EXIT_FIELDS, log: line });
  if (!live) { line("⛔ vault did not go live (ComposeFailed; seed recoverable). Stopping."); process.exit(1); }
  line("   ✓ vault LIVE");
  await ensureFunded(p, dep.address, process.env.DEP_ETH!, String(DEP + 5));
  const dok = await depositTo(p, { managerAddr: mgr.address, dep, amountUsd: DEP, expectDepositors: 1, settleMs: 8000, log: line });
  if (!dok) { line("⛔ depositor deposit did not apply. Stopping (sweep manually)."); process.exit(1); }
  line(`   ✓ depositor $${DEP} applied`);
  eavPre = Number(await ex.loadQuoteQuantityAvailableForExitWithdrawal(mgr.address)) / 1e8;
  line(`   EAV_pre $${eavPre.toFixed(4)}  |  CPP ${cppS}s`);
  await topUpGas(mgr.address);
  const vpMgrX = new ethers.Contract(PROVIDER, PROV_ABI, mgr) as any;
  try { await vpMgrX.exitWallet.staticCall(mgr.address); } catch (e: any) { line(`   ✗ exitWallet staticCall reverted: ${e?.shortMessage ?? e?.reason ?? e?.message}`); process.exit(1); }
  await waitRc((await vpMgrX.exitWallet(mgr.address, { gasLimit: 1_500_000 })).hash);
  const s1 = await vpMgrX.loadVaultSummary(mgr.address);
  line(`   ✓ exitWallet mined — isExited=${s1[1]}`);
  if (!s1[1]) { line("   ✗ vault not exited after exitWallet. Stopping."); process.exit(1); }
  writeFileSync(STATE, JSON.stringify({ run, manager: mgr.address, mgrPk: mgr.privateKey, depPk: dep.privateKey, lastMintAt: Date.now(), phase: "exited", eavPre }, null, 2), { mode: 0o600 });
  line(`   waiting CPP ${cppS + CPP_MARGIN_S}s…`); await sleep((cppS + CPP_MARGIN_S) * 1000);
}
const vpMgr = new ethers.Contract(PROVIDER, PROV_ABI, mgr) as any;

// ── withdrawExit (depositor then manager) ──
await topUpGas(dep.address); await topUpGas(mgr.address);
const depBefore = await usdcRead.balanceOf(dep.address), mgrBefore = await usdcRead.balanceOf(mgr.address);
const vpDep = new ethers.Contract(PROVIDER, PROV_ABI, dep) as any;
for (const [c, m, d, who] of [[vpDep, mgr.address, dep.address, "depositor"], [vpMgr, mgr.address, mgr.address, "manager"]] as const) {
  try { await c.withdrawExit.staticCall(m, d); } catch (e: any) { line(`   ✗ withdrawExit(${who}) staticCall reverted: ${e?.shortMessage ?? e?.reason ?? e?.message}`); continue; }
  await waitRc((await c.withdrawExit(m, d, { gasLimit: 2_500_000 })).hash);
  line(`   ✓ withdrawExit ${who} mined`);
}
const depGot = Number(await usdcRead.balanceOf(dep.address) - depBefore) / 1e6;
const mgrGot = Number(await usdcRead.balanceOf(mgr.address) - mgrBefore) / 1e6;
const recovered = depGot + mgrGot;
const conserved = Math.abs(recovered - eavPre) < 1.0; // within $1 (fees/rounding)
line(`\n   RECOVERED depositor $${depGot.toFixed(4)} + manager $${mgrGot.toFixed(4)} = $${recovered.toFixed(4)}  vs EAV_pre $${eavPre.toFixed(4)}`);
line(`   ${conserved ? "✓" : "✗"} conservation (recovered ${conserved ? "≈" : "≠"} EAV_pre, Δ$${(recovered - eavPre).toFixed(4)})`);

await sweepAll(dep.privateKey, "depositor"); await sweepAll(mgr.privateKey, "manager");
// Merge, never replace: this file holds the only copy of the throwaway keys, and a partially
// failed sweep above would otherwise leave funds with no way to reach them.
writeFileSync(STATE, JSON.stringify({ ...st, run, manager: mgr.address, mgrPk: mgr.privateKey, depPk: dep.privateKey, lastMintAt: Date.now(), phase: "done", conserved, eavPre, recovered }, null, 2), { mode: 0o600 });
line(`\nRESULT exit run #${run} ${mgr.address}: exit+withdrawExit OK, ${conserved ? "CONSERVED" : "MISMATCH"} — funding ETH now ${ethers.formatEther(await p.getBalance(FUNDING.address))}`);
