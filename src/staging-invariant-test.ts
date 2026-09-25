/**
 * staging-invariant-test.ts — LIVE proof (staging) of the exit-vs-manager-withdrawal invariant.
 *
 *   manager may withdraw while   EAV − locked ≥ withdrawMult × owed
 *   anyone may exit the vault when EAV < exitMult × owed
 *
 *   ⇒ if exitMult > withdrawMult, a perfectly VALID manager withdrawal can land EAV in
 *     [withdrawMult×owed, exitMult×owed) and make the vault exit-eligible. If exitMult < withdrawMult it cannot.
 *
 * Vault A ("hole"): exit 200% / withdraw 100%.  Vault B ("fixed"): exit 70% / withdraw 100%.
 * Both: seed $300, one depositor $100, interest 0, caps 100%/100% (so cleanup can drain B).
 *
 *   npx tsx src/staging-invariant-test.ts     (run under `flock /tmp/staging-lab.lock` — shares the funding wallet)
 */
import { readFileSync, appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

// env must be in place BEFORE vault.ts/config.ts evaluate → dynamic imports below (ESM hoists static ones)
const ENVF = "/home/user/code/kperps-test/ikon-vaultgen/docker/staging/.env.staging";
for (const l of readFileSync(ENVF, "utf8").split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }
process.env.STRATEGY ??= "market-making";
process.env.MGR_ETH = "0.00006"; process.env.DEP_ETH = "0.00004";

const { ethers } = await import("ethers");
const { provider, ensureFunded, createVault, depositTo, vaultBalance } = await import("./vault.js");
const { withdrawOnChain } = await import("./withdraw-onchain.js");

const LOG = "/home/user/code/kperps-test/foundry-tests/ops/logs/staging-invariant-test.log";
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

const SEED = 300, DEP = 100;
const baseFields = {
  interestMultiplierInPips: 0n, maximumNetDepositsInPips: pip(5000),
  minimumTotalOwedQuantityAvailableForExitWithdrawalMultiplierToAllowManagerWalletWithdrawalInPips: pip(1.00),
  minimumUnappliedWithdrawalAgeInSNeededToInitiateExit: 86400,
  withdrawalLimitPercentForDepositorsInPips: pip(1.00), withdrawalLimitPercentForVaultInPips: pip(1.00),
};
const VP_ABI = [
  "function exitWallet(address)", "function withdrawExit(address,address)",
  "function loadVaultSummary(address) view returns ((bool,bool,bool,bool,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64))",
  "function loadVaultBalanceForWalletSummary(address,address) view returns ((uint64,uint64,uint64,uint64,uint64,uint64,uint64))",
  "error WalletCannotBeExited()", "error WithdrawalQuantityExceedsLimit(uint64 available, uint64 requested)",
  "error VaultIsExited()", "error SenderMustBeDepositorWallet()",
];
const EX_ABI = ["function loadQuoteQuantityAvailableForExitWithdrawal(address) view returns (int64)", "function chainPropagationPeriodInS() view returns (uint256)"];
const ex = new ethers.Contract(EXCHANGE, EX_ABI, p) as any;
const vpRead = new ethers.Contract(PROVIDER, VP_ABI, p) as any;
const usdc = new ethers.Contract(QUOTE, ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"], p) as any;

const eav = async (mgr: string) => Number(await ex.loadQuoteQuantityAvailableForExitWithdrawal(mgr)) / 1e8;
const totalOwed = async (mgr: string) => Number((await vpRead.loadVaultSummary(mgr))[12]) / 1e8;
const mgrLocked = async (mgr: string) => Number((await vpRead.loadVaultSummary(mgr))[8]) / 1e8;
/** why exitWallet would revert right now, or "ELIGIBLE" */
async function exitStatus(mgr: any): Promise<string> {
  const c = new ethers.Contract(PROVIDER, VP_ABI, mgr) as any;
  try { await c.exitWallet.staticCall(mgr.address); return "ELIGIBLE"; }
  catch (e: any) { return e?.revert?.name ?? e?.errorName ?? e?.shortMessage ?? String(e?.message).slice(0, 60); }
}
const ERR_IFACE = new ethers.Interface(VP_ABI);
/** Submit through the real signed path; withdrawOnChain staticCalls first, so a rejection never sends. */
async function withdrawStatus(w: any, mgr: string, qty: number): Promise<string> {
  try { await withdrawOnChain(p, w, mgr, qty); return "ACCEPTED"; }
  catch (e: any) {
    const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
    try { const d = ERR_IFACE.parseError(data); if (d) return `${d.name}(${d.args.map((a: any) => (typeof a === "bigint" ? (Number(a) / 1e8).toFixed(2) : String(a))).join(", ")})`; } catch { /* not one of ours */ }
    return e?.revert?.name ?? e?.errorName ?? e?.shortMessage ?? String(e?.message).slice(0, 80);
  }
}
async function waitApplied(mgr: string, eavBelow: number, label: string) {
  for (let i = 0; i < 30; i++) { if ((await eav(mgr)) <= eavBelow + 0.01) return true; await sleep(6000); }
  line(`   ! ${label}: dispatcher did not apply within 180s (EAV ${(await eav(mgr)).toFixed(2)})`); return false;
}
async function sweep(w: any, label: string) {
  try { const fd = await p.getFeeData(); const maxFee = (fd.maxFeePerGas ?? 3_000_000n) * 2n;
    const u = await usdc.balanceOf(w.address); if (u > 0n) { await waitRc((await (usdc.connect(w) as any).transfer(FUNDING.address, u, { gasLimit: 80_000n, maxFeePerGas: maxFee })).hash); line(`   swept ${ethers.formatUnits(u, 6)} vbUSDC from ${label}`); }
    const bal = await p.getBalance(w.address), reserve = 21000n * maxFee + 1_000_000_000_000n;
    if (bal > reserve * 2n) { await waitRc((await w.sendTransaction({ to: FUNDING.address, value: bal - reserve, gasLimit: 21000n, maxFeePerGas: maxFee, maxPriorityFeePerGas: fd.maxPriorityFeePerGas ?? 1_000_000n })).hash); }
  } catch (e: any) { line(`   sweep ${label} skipped: ${String(e?.shortMessage ?? e?.message).slice(0, 80)}`); }
}

async function mintVault(tag: string, exitMult: number) {
  const mgr = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, p), dep = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, p);
  line(`\n[${now()}] ── vault ${tag}: exit ${exitMult * 100}% / withdraw 100%  manager ${mgr.address}  (seed $${SEED}, dep $${DEP}) ──`);
  await ensureFunded(p, mgr.address, process.env.MGR_ETH!, String(SEED + 25));
  const fields = { ...baseFields, maximumTotalOwedQuantityAvailableForExitWithdrawalMultiplierNeededToInitiateExitInPips: pip(exitMult) };
  const live = await createVault(p, { manager: mgr, seedUsd: SEED, fields, log: line });
  if (!live) throw new Error(`vault ${tag} did not go live`);
  await ensureFunded(p, dep.address, process.env.DEP_ETH!, String(DEP + 5));
  const ok = await depositTo(p, { managerAddr: mgr.address, dep, amountUsd: DEP, expectDepositors: 1, settleMs: 8000, log: line });
  if (!ok) throw new Error(`vault ${tag}: depositor deposit not applied`);
  return { mgr, dep };
}

async function scenario(tag: string, exitMult: number, expectHole: boolean) {
  const { mgr, dep } = await mintVault(tag, exitMult);
  const owed0 = await totalOwed(mgr.address), eav0 = await eav(mgr.address);
  const exitThreshold = exitMult * owed0, withdrawFloor = 1.0 * owed0;
  line(`   state: EAV ${eav0.toFixed(2)}  owed ${owed0.toFixed(2)}  exit if EAV < ${exitThreshold.toFixed(2)}  manager may withdraw down to EAV = ${withdrawFloor.toFixed(2)}`);
  const s0 = await exitStatus(mgr);
  check(`${tag}-not-eligible-before`, s0 === "WalletCannotBeExited", `exitWallet before any withdrawal → ${s0}`);

  // over-limit manager withdrawal must be rejected at enqueue
  const withdrawable = eav0 - (await mgrLocked(mgr.address)) - withdrawFloor;
  const over = await withdrawStatus(mgr, mgr.address, Math.floor((withdrawable + 5) * 100) / 100);
  check(`${tag}-over-limit-rejected`, /WithdrawalQuantityExceedsLimit/.test(over), `manager asks $${(withdrawable + 5).toFixed(2)} (> withdrawable $${withdrawable.toFixed(2)}) → ${over}`);

  // max VALID manager withdrawal (leave 1¢ under the cap for rounding), dispatcher applies it
  const take = Math.floor((withdrawable - 0.01) * 100) / 100;
  const acc = await withdrawStatus(mgr, mgr.address, take);
  check(`${tag}-max-withdrawal-accepted`, acc === "ACCEPTED", `manager withdraws $${take.toFixed(2)} → ${acc}`);
  const applied = await waitApplied(mgr.address, eav0 - take, `${tag} manager withdrawal`);
  const eav1 = await eav(mgr.address);
  check(`${tag}-withdrawal-applied`, applied, `EAV ${eav0.toFixed(2)} → ${eav1.toFixed(2)} (floor ${withdrawFloor.toFixed(2)})`);

  const s1 = await exitStatus(mgr);
  if (expectHole) check(`${tag}-HOLE-valid-withdrawal-made-vault-exitable`, s1 === "ELIGIBLE", `exit threshold ${exitThreshold.toFixed(2)} > EAV ${eav1.toFixed(2)} → exitWallet ${s1}`);
  else check(`${tag}-FIXED-still-not-exitable`, s1 === "WalletCannotBeExited", `exit threshold ${exitThreshold.toFixed(2)} ≤ EAV ${eav1.toFixed(2)} → exitWallet ${s1}`);
  return { mgr, dep, eligible: s1 === "ELIGIBLE" };
}

async function cleanupExit(mgr: any, dep: any, tag: string) {
  const cppS = Number(await ex.chainPropagationPeriodInS());
  const c = new ethers.Contract(PROVIDER, VP_ABI, mgr) as any;
  const eavPre = await eav(mgr.address);
  await waitRc((await c.exitWallet(mgr.address, { gasLimit: 1_500_000 })).hash); line(`   ${tag}: exitWallet mined (EAV_pre ${eavPre.toFixed(2)}), CPP ${cppS}s…`); await sleep((cppS + 30) * 1000);
  const b0 = await usdc.balanceOf(dep.address) + await usdc.balanceOf(mgr.address);
  for (const [w, who] of [[dep, "depositor"], [mgr, "manager"]] as const) { const cc = new ethers.Contract(PROVIDER, VP_ABI, w) as any; await waitRc((await cc.withdrawExit(mgr.address, w.address, { gasLimit: 2_500_000 })).hash); line(`   ${tag}: withdrawExit ${who} mined`); }
  const got = Number(await usdc.balanceOf(dep.address) + await usdc.balanceOf(mgr.address) - b0) / 1e6;
  check(`${tag}-exit-conservation`, Math.abs(got - eavPre) < 0.02, `recovered $${got.toFixed(4)} vs EAV_pre $${eavPre.toFixed(4)}`);
  await sweep(dep, `${tag} depositor`); await sweep(mgr, `${tag} manager`);
}
async function cleanupDrain(mgr: any, dep: any, tag: string) {
  // B cannot be exited (that is the point) → depositor withdraws everything (caps 100/100), then manager takes the rest
  const owed = (await vaultBalance(p, mgr.address, dep.address)).owed;
  const r1 = await withdrawStatus(dep, mgr.address, Math.floor(owed * 100) / 100); line(`   ${tag}: depositor withdraws $${owed.toFixed(2)} → ${r1}`);
  for (let i = 0; i < 30 && (await totalOwed(mgr.address)) > 0.02; i++) await sleep(6000);
  const rest = (await eav(mgr.address)) - (await mgrLocked(mgr.address)) - 0.01;
  const r2 = await withdrawStatus(mgr, mgr.address, Math.floor(rest * 100) / 100); line(`   ${tag}: manager withdraws remaining $${rest.toFixed(2)} → ${r2}`);
  for (let i = 0; i < 30 && (await eav(mgr.address)) > 0.05; i++) await sleep(6000);
  line(`   ${tag}: vault left as an empty live shell (EAV ${(await eav(mgr.address)).toFixed(2)})`);
  await sweep(dep, `${tag} depositor`); await sweep(mgr, `${tag} manager`);
}

mkdirSync(dirname(LOG), { recursive: true });
line(`\n════════ staging-invariant-test ${now()} ════════`);
line(`funding ${FUNDING.address} ETH ${ethers.formatEther(await p.getBalance(FUNDING.address))}`);
const A = await scenario("A(exit200/withdraw100)", 2.0, true);
const B = await scenario("B(exit70/withdraw100)", 0.7, false);
line(`\n[${now()}] ── cleanup ──`);
if (A.eligible) await cleanupExit(A.mgr, A.dep, "A"); else await cleanupDrain(A.mgr, A.dep, "A");
if (B.eligible) await cleanupExit(B.mgr, B.dep, "B"); else await cleanupDrain(B.mgr, B.dep, "B");
const pass = results.filter((r) => r.pass).length;
line(`\nRESULT: ${pass}/${results.length} passed — funding ETH ${ethers.formatEther(await p.getBalance(FUNDING.address))}`);
