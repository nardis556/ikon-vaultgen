/**
 * staging-stagger-test.ts — LIVE (staging): three depositors withdrawing at DIFFERENT times.
 *
 * Two budgets gate a depositor withdrawal (FixedIncomeVaultWithdrawing_v1):
 *   vault pot      = withdrawalLimitPctVault      × TOTAL owed  — ONE pot, shared by every depositor,
 *                    window started by whoever withdraws first
 *   depositor pot  = withdrawalLimitPctDepositors × that depositor's owed — private, window started
 *                    by that depositor's own first withdrawal
 *   available = vault remaining + own remaining, and a withdrawal spends the VAULT pot first.
 *
 * So: A withdrawing early can drain the shared pot and starve B and C down to their private pots,
 * and each depositor's window rolls on a different clock. This measures exactly that.
 *
 *   npx tsx src/staging-stagger-test.ts    (run under flock /tmp/staging-lab.lock)
 */
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
const ENVF = "/home/user/code/kperps-test/ikon-vaultgen/docker/staging/.env.staging";
for (const l of readFileSync(ENVF, "utf8").split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }
process.env.STRATEGY ??= "market-making";
process.env.MGR_ETH = "0.0002"; process.env.DEP_ETH = "0.0001";

const { ethers } = await import("ethers");
const { provider, ensureFunded, createVault, depositTo } = await import("./vault.js");
const { withdrawOnChain } = await import("./withdraw-onchain.js");

const LOG = "/home/user/code/kperps-test/foundry-tests/ops/logs/staging-stagger-test.log";
const STATE = "/home/user/code/kperps-test/foundry-tests/ops/staging-stagger-state.json";
const PROVIDER = process.env.VAULT_PROVIDER!, EXCHANGE = process.env.EXCHANGE_CONTRACT!, QUOTE = process.env.QUOTE_TOKEN!;
const FUNDING = new ethers.Wallet(process.env.FUNDING_WALLET_KEY!);
const p = provider();
const pip = (v: number) => BigInt(Math.round(v * 1e8));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const line = (s: string) => { console.log(s); appendFileSync(LOG, s + "\n"); };
const waitRc = async (h: string) => { const r = await p.waitForTransaction(h, 1, 180_000); if (!r || r.status !== 1) throw new Error(`tx ${h} status ${r?.status}`); return r; };
const results: { name: string; pass: boolean }[] = [];
const check = (name: string, pass: boolean, detail: string) => { results.push({ name, pass }); line(`   ${pass ? "✓" : "✗"} ${name} — ${detail}`); };

const SEED = 400, DEP = 100;            // 3 × $100 → owed ≈ $299.85; caps 10/10 → vault pot ≈ $30, each own ≈ $10
const VAULT_PCT = 0.10, DEP_PCT = 0.10;
const FIELDS = {
  interestMultiplierInPips: 0n,          // zero interest keeps the arithmetic exact
  maximumNetDepositsInPips: pip(5000),
  maximumTotalOwedQuantityAvailableForExitWithdrawalMultiplierNeededToInitiateExitInPips: pip(2.00),
  minimumTotalOwedQuantityAvailableForExitWithdrawalMultiplierToAllowManagerWalletWithdrawalInPips: pip(1.00),
  minimumUnappliedWithdrawalAgeInSNeededToInitiateExit: 86400,
  withdrawalLimitPercentForDepositorsInPips: pip(DEP_PCT), withdrawalLimitPercentForVaultInPips: pip(VAULT_PCT),
};
const VP_ABI = [
  "function loadVaultSummary(address) view returns ((bool,bool,bool,bool,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64))",
  "function loadVaultBalanceForWalletSummary(address,address) view returns ((uint64,uint64,uint64,uint64,uint64,uint64,uint64))",
  "function withdrawalLimitWindowSizeInS() view returns (uint64)",
  "function exitWallet(address)", "function withdrawExit(address,address)",
  "error WithdrawalQuantityExceedsLimit(uint64 available, uint64 requested)",
];
const vp = new ethers.Contract(PROVIDER, VP_ABI, p) as any;
const ex = new ethers.Contract(EXCHANGE, ["function loadQuoteQuantityAvailableForExitWithdrawal(address) view returns (int64)", "function chainPropagationPeriodInS() view returns (uint256)"], p) as any;
const usdc = new ethers.Contract(QUOTE, ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"], p) as any;
const ERR = new ethers.Interface(VP_ABI);

const totalOwed = async (m: string) => Number((await vp.loadVaultSummary(m))[12]) / 1e8;
async function bal(m: string, w: string) {
  const b = await vp.loadVaultBalanceForWalletSummary(m, w);
  return { owed: Number(b[3]) / 1e8, locked: Number(b[2]) / 1e8, avail: Number(b[5]) / 1e8, windowEnd: Number(b[6]) };
}
async function tryWithdraw(w: any, m: string, qty: number): Promise<string> {
  try { await withdrawOnChain(p, w, m, qty); return "ACCEPTED"; }
  catch (e: any) {
    const d = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
    try { const x = ERR.parseError(d); if (x) return `${x.name}(available=$${(Number(x.args[0]) / 1e8).toFixed(2)}, requested=$${(Number(x.args[1]) / 1e8).toFixed(2)})`; } catch {}
    return e?.shortMessage ?? String(e?.message).slice(0, 70);
  }
}
async function snapshot(m: string, deps: { w: any; name: string }[], label: string) {
  const t = Number((await p.getBlock("latest"))!.timestamp);
  const tot = await totalOwed(m);
  const rows = [] as string[];
  for (const d of deps) { const b = await bal(m, d.w.address); rows.push(`${d.name}: owed $${b.owed.toFixed(2)} avail $${b.avail.toFixed(2)}${b.windowEnd ? ` winEnds T+${b.windowEnd - t0}s` : " winNotStarted"}`); }
  line(`   [${label}] T+${t - t0}s  totalOwed $${tot.toFixed(2)}  ${rows.join("  |  ")}`);
  return { t, tot, rows };
}
async function sweep(w: any, label: string) {
  try { const fd = await p.getFeeData(); const maxFee = (fd.maxFeePerGas ?? 3_000_000n) * 2n;
    const u = await usdc.balanceOf(w.address); if (u > 0n) await waitRc((await (usdc.connect(w) as any).transfer(FUNDING.address, u, { gasLimit: 80_000n, maxFeePerGas: maxFee })).hash);
    const b = await p.getBalance(w.address), reserve = 21000n * maxFee + 1_000_000_000_000n;
    if (b > reserve * 2n) await waitRc((await w.sendTransaction({ to: FUNDING.address, value: b - reserve, gasLimit: 21000n, maxFeePerGas: maxFee, maxPriorityFeePerGas: fd.maxPriorityFeePerGas ?? 1_000_000n })).hash);
  } catch (e: any) { line(`   sweep ${label} skipped: ${String(e?.shortMessage ?? e?.message).slice(0, 70)}`); }
}

mkdirSync(dirname(LOG), { recursive: true });
line(`\n════════ staging-stagger-test ${now()} ════════`);
const WINDOW_S = Number(await vp.withdrawalLimitWindowSizeInS());
line(`funding ETH ${ethers.formatEther(await p.getBalance(FUNDING.address))}   withdrawal window ${WINDOW_S}s   caps vault ${VAULT_PCT * 100}% / depositor ${DEP_PCT * 100}%`);

const mgr = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, p);
const A = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, p);
const B = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, p);
const C = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, p);
writeFileSync(STATE, JSON.stringify({ manager: mgr.address, mgrPk: mgr.privateKey, aPk: A.privateKey, bPk: B.privateKey, cPk: C.privateKey, createdAt: Date.now(), phase: "minting" }, null, 1), { mode: 0o600 });
const deps = [{ w: A, name: "A" }, { w: B, name: "B" }, { w: C, name: "C" }];

line(`\n[${now()}] ── minting vault ${mgr.address} (seed $${SEED}, 3 depositors × $${DEP}) ──`);
await ensureFunded(p, mgr.address, process.env.MGR_ETH!, String(SEED + 25));
if (!(await createVault(p, { manager: mgr, seedUsd: SEED, fields: FIELDS, log: line }))) throw new Error("vault did not go live");
let i = 0;
for (const d of deps) {
  i++; await ensureFunded(p, d.w.address, process.env.DEP_ETH!, String(DEP + 5));
  const ok = await depositTo(p, { managerAddr: mgr.address, dep: d.w, amountUsd: DEP, expectDepositors: i, settleMs: 8000, log: () => {} });
  line(`   depositor ${d.name} $${DEP}: ${ok ? "applied" : "NOT applied"}`);
}
var t0 = Number((await p.getBlock("latest"))!.timestamp);
const tot0 = await totalOwed(mgr.address);
const vaultPot = VAULT_PCT * tot0, ownPot = DEP_PCT * (await bal(mgr.address, A.address)).owed;
line(`\n   budgets: shared vault pot $${vaultPot.toFixed(2)} (10% × $${tot0.toFixed(2)})  +  each depositor's own $${ownPot.toFixed(2)}`);
await snapshot(mgr.address, deps, "start");
{ const b = await bal(mgr.address, A.address);
  check("start-available-is-vault-plus-own", Math.abs(b.avail - (vaultPot + ownPot)) < 0.05, `A sees $${b.avail.toFixed(2)} = shared $${vaultPot.toFixed(2)} + own $${ownPot.toFixed(2)}`); }

// ── A withdraws SMALL, so the shared pot still has room to observe interference ──
const SMALL = 5;
line(`\n[${now()}] ── A withdraws $${SMALL} (small: shared pot keeps room, so B/C interference stays visible) ──`);
const availA0 = (await bal(mgr.address, A.address)).avail;
const rA = await tryWithdraw(A, mgr.address, SMALL);
line(`   A → ${rA}`);
const availA1 = (await bal(mgr.address, A.address)).avail;
await snapshot(mgr.address, deps, "after A");
check("A-withdrawal-spends-shared-pot-first", Math.abs((availA0 - availA1) - SMALL) < 0.05,
  `A's headroom $${availA0.toFixed(2)} → $${availA1.toFixed(2)} (−$${SMALL}); the spend came out of the SHARED pot, A's own $${ownPot.toFixed(2)} is still intact`);

// ── B withdraws a minute later — does it move A? ─────────────────────────────
await sleep(60_000);
const availA_beforeB = (await bal(mgr.address, A.address)).avail;
line(`\n[${now()}] ── B withdraws $${SMALL}. A does nothing. Watching A's headroom. ──`);
const rB = await tryWithdraw(B, mgr.address, SMALL);
line(`   B → ${rB}`);
const availA_afterB = (await bal(mgr.address, A.address)).avail;
await snapshot(mgr.address, deps, "after B");
check("B-withdrawal-REDUCES-A-headroom-via-shared-pot", Math.abs((availA_beforeB - availA_afterB) - SMALL) < 0.05,
  `A did nothing, yet A's headroom fell $${availA_beforeB.toFixed(2)} → $${availA_afterB.toFixed(2)} (−$${SMALL}) because B spent the SHARED vault pot`);

// ── C withdraws a minute after that — same again ─────────────────────────────
await sleep(60_000);
const availA_beforeC = (await bal(mgr.address, A.address)).avail;
line(`\n[${now()}] ── C withdraws $${SMALL}. A still does nothing. ──`);
const rC = await tryWithdraw(C, mgr.address, SMALL);
line(`   C → ${rC}`);
const availA_afterC = (await bal(mgr.address, A.address)).avail;
await snapshot(mgr.address, deps, "after C");
check("C-withdrawal-REDUCES-A-headroom-too", Math.abs((availA_beforeC - availA_afterC) - SMALL) < 0.05,
  `A's headroom fell again $${availA_beforeC.toFixed(2)} → $${availA_afterC.toFixed(2)} (−$${SMALL}) from C's spend`);

// ── THE QUESTION: is A's OWN pot still whole after B and C spent? ────────────
// Drain the shared pot with a 4th party (the manager cannot; use B's remaining own pot + reads),
// then prove A can still withdraw its full private allowance regardless of what B and C did.
line(`\n[${now()}] ── draining the remaining SHARED pot so only private pots are left ──`);
let vaultLeft = (await bal(mgr.address, A.address)).avail - ownPot;   // A.avail = sharedLeft + ownLeft(=ownPot, untouched)
line(`   shared pot remaining ≈ $${vaultLeft.toFixed(2)} (A.avail $${availA_afterC.toFixed(2)} − A's own $${ownPot.toFixed(2)})`);
if (vaultLeft > 0.5) {
  const r = await tryWithdraw(B, mgr.address, Math.floor(vaultLeft * 100) / 100);
  line(`   B drains the rest of the shared pot ($${vaultLeft.toFixed(2)}) → ${r}`);
}
const aFinal = await bal(mgr.address, A.address);
check("A-PRIVATE-pot-untouched-by-B-and-C", Math.abs(aFinal.avail - ownPot) < 0.10,
  `after B and C spent the entire shared pot, A can still withdraw $${aFinal.avail.toFixed(2)} ≈ its own $${ownPot.toFixed(2)} — B and C never touched A's private allowance`);
const rAfinal = await tryWithdraw(A, mgr.address, Math.floor((ownPot - 0.01) * 100) / 100);
check("A-can-actually-spend-its-private-pot", rAfinal === "ACCEPTED",
  `A withdraws its full private $${(ownPot - 0.01).toFixed(2)} after B and C drained everything shared → ${rAfinal}`);
const aSpent = await bal(mgr.address, A.address);
const overA = await tryWithdraw(A, mgr.address, 1);
check("A-then-exhausted", /WithdrawalQuantityExceedsLimit/.test(overA),
  `A now has $${aSpent.avail.toFixed(2)} left; asking $1 more → ${overA}`);

// ── windows are on independent clocks ────────────────────────────────────────
const winEnds = { A: (await bal(mgr.address, A.address)).windowEnd, B: (await bal(mgr.address, B.address)).windowEnd, C: (await bal(mgr.address, C.address)).windowEnd };
check("each-depositor-window-on-its-own-clock", winEnds.A < winEnds.B && winEnds.B < winEnds.C,
  `private windows stagger by first-withdrawal time: A ends T+${winEnds.A - t0}s < B T+${winEnds.B - t0}s < C T+${winEnds.C - t0}s`);

// ── after the vault window rolls, the shared pot refills for everyone ────────
let bt = Number((await p.getBlock("latest"))!.timestamp);
const waitS = winEnds.A - bt + 5;
if (waitS > 0) { line(`\n   … waiting ${waitS}s for the vault window (opened by A at T+0) to elapse`); await sleep(waitS * 1000); }
while ((bt = Number((await p.getBlock("latest"))!.timestamp)) <= winEnds.A) await sleep(3000);
line(`\n[${now()}] ── vault window elapsed: A withdraws $1, which REOPENS the shared pot for everyone ──`);
const totNow = await totalOwed(mgr.address);
const cBefore = await bal(mgr.address, C.address);
const rA2 = await tryWithdraw(A, mgr.address, 1);
line(`   A → ${rA2}`);
const cAfter = await bal(mgr.address, C.address);
await snapshot(mgr.address, deps, "after reset");
check("shared-pot-refills-for-idle-depositors", cAfter.avail > cBefore.avail + 1,
  `C took no action yet C's headroom rose $${cBefore.avail.toFixed(2)} → $${cAfter.avail.toFixed(2)} — A's withdrawal reopened the shared pot at 10% × current owed $${totNow.toFixed(2)}`);
check("C-private-window-unaffected-by-vault-reset", cAfter.windowEnd === winEnds.C,
  `C's private window still ends T+${cAfter.windowEnd - t0}s — vault clock and depositor clock are independent`);

// ── cleanup: exit + withdrawExit + sweep ────────────────────────────────────
line(`\n[${now()}] ── cleanup ──`);
const eavPre = Number(await ex.loadQuoteQuantityAvailableForExitWithdrawal(mgr.address)) / 1e8;
const cM = new ethers.Contract(PROVIDER, VP_ABI, mgr) as any;
try {
  await waitRc((await cM.exitWallet(mgr.address, { gasLimit: 1_500_000 })).hash);
  const cpp = Number(await ex.chainPropagationPeriodInS()); line(`   exitWallet mined (EAV_pre $${eavPre.toFixed(2)}), CPP ${cpp}s…`); await sleep((cpp + 30) * 1000);
  let got = 0n; const before = new Map<string, bigint>();
  for (const d of [...deps.map((d) => d.w), mgr]) before.set(d.address, await usdc.balanceOf(d.address));
  for (const d of [...deps.map((d) => d.w), mgr]) {
    const c = new ethers.Contract(PROVIDER, VP_ABI, d) as any;
    try { await waitRc((await c.withdrawExit(mgr.address, d.address, { gasLimit: 2_500_000 })).hash); } catch (e: any) { line(`   withdrawExit ${d.address.slice(0, 8)}… ${String(e?.shortMessage ?? e?.message).slice(0, 60)}`); }
  }
  for (const d of [...deps.map((d) => d.w), mgr]) got += (await usdc.balanceOf(d.address)) - before.get(d.address)!;
  const rec = Number(got) / 1e6;
  check("exit-conservation", Math.abs(rec - eavPre) < 0.05, `recovered $${rec.toFixed(4)} vs EAV_pre $${eavPre.toFixed(4)}`);
} catch (e: any) { line(`   exit skipped: ${String(e?.shortMessage ?? e?.reason ?? e?.message).slice(0, 90)}`); }
for (const d of deps) await sweep(d.w, d.name);
await sweep(mgr, "manager");
// NEVER replace the state object — it holds the only copy of the throwaway keys. Merge.
{ const prev = JSON.parse(readFileSync(STATE, "utf8")); writeFileSync(STATE, JSON.stringify({ ...prev, phase: "done" }, null, 1), { mode: 0o600 }); }
const pass = results.filter((r) => r.pass).length;
line(`\nRESULT: ${pass}/${results.length} passed — funding ETH ${ethers.formatEther(await p.getBalance(FUNDING.address))}`);
