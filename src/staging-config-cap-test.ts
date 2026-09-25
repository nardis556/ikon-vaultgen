/**
 * staging-config-cap-test.ts — LIVE (staging): push one vault to the 100-config cap and measure the
 * interest config-history walk's gas at 1/10/25/50/75/100 configs, then prove the 101st is refused.
 *
 * Design (2nd version): the interest walk only spans configs added since the vault's LAST interest update
 * (every deposit/withdraw advances that timestamp), so the number that matters is a DORMANT vault waking up:
 * mint → add 99 configs with no activity → ONE deposit → the dispatcher's applyPendingDeposit walks all 99.
 * The cumulative per-point measurement (kept as PHASE A when POINTS has >1 entry) gives the per-config slope.
 *
 * Per measurement point (real txs, real dispatcher):
 *   deposit-apply gas   — depositor deposits $1 via the adapter; the dispatcher's applyPendingDeposit
 *                         tx (found via DepositToManagedAccountApplied) gives gasUsed        ← 4M dispatcher budget
 *   withdraw-enqueue gas— depositor's own withdrawByQuantity tx gasUsed (walk runs at enqueue)
 *   withdraw-apply gas  — dispatcher's applyPendingWithdrawal tx gasUsed (expected flat)
 *   balance-view gas    — eth_estimateGas of loadVaultBalanceForWalletSummary
 *   exitWallet gas      — estimateGas (vault is exit-eligible by construction)
 * Staging upgradeDelay = 0 → initiate+finalize per config. Run under `flock /tmp/staging-lab.lock`.
 */
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { dirname } from "path";
const ENVF = "/home/user/code/kperps-test/ikon-vaultgen/docker/staging/.env.staging";
for (const l of readFileSync(ENVF, "utf8").split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }
process.env.STRATEGY ??= "market-making";
process.env.MGR_ETH = "0.002"; process.env.DEP_ETH = "0.0003";   // ~200 upgrade txs: the node pre-check wants ≥5.2e12 wei per tx (L1 estimate)

const { ethers } = await import("ethers");
const { encodeFixedIncomeVaultConfigurationFields } = await import("@katanaperps/katana-perps-sdk");
const { provider, ensureFunded, createVault, depositTo } = await import("./vault.js");
const { withdrawOnChain } = await import("./withdraw-onchain.js");

const LOG = "/home/user/code/kperps-test/foundry-tests/ops/logs/staging-config-cap-test.log";
const STATE = "/home/user/code/kperps-test/foundry-tests/ops/staging-config-cap-state.json";   // keys persisted BEFORE the first tx
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

const SEED = 120, DEP = 150;
const POINTS = (process.env.POINTS ?? "100").split(",").map(Number);   // default: one full 99-config walk
const FIELDS = {
  interestMultiplierInPips: pip(0.10), maximumNetDepositsInPips: pip(5000),
  maximumTotalOwedQuantityAvailableForExitWithdrawalMultiplierNeededToInitiateExitInPips: pip(2.00),
  minimumTotalOwedQuantityAvailableForExitWithdrawalMultiplierToAllowManagerWalletWithdrawalInPips: pip(1.00),
  minimumUnappliedWithdrawalAgeInSNeededToInitiateExit: 86400,
  withdrawalLimitPercentForDepositorsInPips: pip(1.00), withdrawalLimitPercentForVaultInPips: pip(1.00),
};
const encodeCfg = (mgr: string, f: any) => encodeFixedIncomeVaultConfigurationFields({ managerWallet: mgr, effectiveTimestampInS: 0, ...f });
const VP_ABI = [
  "function initiateManagedAccountUpgrade(bytes payload)", "function finalizeManagedAccountUpgrade()",
  "function loadVaultConfigurationsLength(address) view returns (uint256)",
  "function loadVaultSummary(address) view returns ((bool,bool,bool,bool,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64))",
  "function loadVaultBalanceForWalletSummary(address,address) view returns ((uint64,uint64,uint64,uint64,uint64,uint64,uint64))",
  "function exitWallet(address)", "function withdrawExit(address,address)",
  "event DepositToManagedAccountApplied(address indexed managerWallet, address depositorWallet, uint64 quantity, uint64 newWalletOwedQuantity, uint64 newVaultTotalOwedQuantity)",
  "event WithdrawalFromManagedAccountApplied(address indexed managerWallet, address depositorWallet, uint64 quantity, uint64 newWalletOwedQuantity, uint64 newVaultTotalOwedQuantity)",
  "error MaximumVaultConfigurationsReached(uint256 limit)", "error WalletCannotBeExited()",
];
const vpRead = new ethers.Contract(PROVIDER, VP_ABI, p) as any;
const ex = new ethers.Contract(EXCHANGE, ["function loadQuoteQuantityAvailableForExitWithdrawal(address) view returns (int64)", "function chainPropagationPeriodInS() view returns (uint256)"], p) as any;
const usdc = new ethers.Contract(QUOTE, ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"], p) as any;
const iface = new ethers.Interface(VP_ABI);
const nCfg = async (mgr: string) => Number(await vpRead.loadVaultConfigurationsLength(mgr));

/** Wait for the dispatcher's apply tx for this vault after `fromBlock` and return its gasUsed. */
async function dispatcherApplyGas(eventName: string, mgr: string, fromBlock: number): Promise<{ gas: number; block: number } | null> {
  const filter = vpRead.filters[eventName](mgr);
  for (let i = 0; i < 40; i++) {
    const logs = await vpRead.queryFilter(filter, fromBlock, "latest");
    if (logs.length) { const l = logs[logs.length - 1]; const rc = await p.getTransactionReceipt(l.transactionHash); return { gas: Number(rc!.gasUsed), block: l.blockNumber }; }
    await sleep(5000);
  }
  return null;
}

/** initiate+finalize `count` times (delay 0) with pipelined nonces; returns avg gas per pair. */
async function addConfigs(mgr: any, count: number, startIdx: number): Promise<number> {
  const c = new ethers.Contract(PROVIDER, VP_ABI, mgr) as any;
  let gasSum = 0;
  for (let i = 0; i < count; i++) {
    const f = { ...FIELDS, maximumNetDepositsInPips: FIELDS.maximumNetDepositsInPips + BigInt(startIdx + i) };
    const nonce = await p.getTransactionCount(mgr.address, "pending");
    const t1 = await c.initiateManagedAccountUpgrade(encodeCfg(mgr.address, f), { gasLimit: 400_000, nonce });
    const t2 = await c.finalizeManagedAccountUpgrade({ gasLimit: 400_000, nonce: nonce + 1 });
    const [r1, r2] = await Promise.all([waitRc(t1.hash), waitRc(t2.hash)]);
    gasSum += Number(r1.gasUsed) + Number(r2.gasUsed);
  }
  return count ? gasSum / count : 0;
}

type Row = { configs: number; depositApply: number | null; withdrawEnqueue: number; withdrawApply: number | null; balanceView: number; exitEstimate: number | null };
const rows: Row[] = [];

async function measure(mgr: any, dep: any, label: string): Promise<Row> {
  const configs = await nCfg(mgr.address);
  const b0 = await p.getBlockNumber();
  // deposit $1 → dispatcher apply gas
  const ok = await depositTo(p, { managerAddr: mgr.address, dep, amountUsd: 1, expectDepositors: 1, settleMs: 5000, log: () => {} });
  const dApply = ok ? await dispatcherApplyGas("DepositToManagedAccountApplied", mgr.address, b0) : null;
  // withdraw $1 → enqueue gas (own tx) + dispatcher apply gas
  const b1 = await p.getBlockNumber();
  const wh = await withdrawOnChain(p, dep, mgr.address, 1);
  const wEnq = Number((await p.getTransactionReceipt(wh))!.gasUsed);
  const wApply = await dispatcherApplyGas("WithdrawalFromManagedAccountApplied", mgr.address, b1);
  // view + exit estimates
  const balanceView = Number(await vpRead.loadVaultBalanceForWalletSummary.estimateGas(mgr.address, dep.address));
  let exitEstimate: number | null = null;
  try { exitEstimate = Number(await (new ethers.Contract(PROVIDER, VP_ABI, mgr) as any).exitWallet.estimateGas(mgr.address)); } catch { exitEstimate = null; }
  const row: Row = { configs, depositApply: dApply?.gas ?? null, withdrawEnqueue: wEnq, withdrawApply: wApply?.gas ?? null, balanceView, exitEstimate };
  rows.push(row);
  line(`   [${label}] configs=${configs}  deposit-apply ${row.depositApply ?? "n/a"}  withdraw-enqueue ${wEnq}  withdraw-apply ${row.withdrawApply ?? "n/a"}  balance-view ${balanceView}  exitWallet-est ${exitEstimate ?? "n/a"}`);
  return row;
}

async function sweep(w: any, label: string) {
  try { const fd = await p.getFeeData(); const maxFee = (fd.maxFeePerGas ?? 3_000_000n) * 2n;
    const u = await usdc.balanceOf(w.address); if (u > 0n) { await waitRc((await (usdc.connect(w) as any).transfer(FUNDING.address, u, { gasLimit: 80_000n, maxFeePerGas: maxFee })).hash); line(`   swept ${ethers.formatUnits(u, 6)} vbUSDC from ${label}`); }
    const bal = await p.getBalance(w.address), reserve = 21000n * maxFee + 1_000_000_000_000n;
    if (bal > reserve * 2n) await waitRc((await w.sendTransaction({ to: FUNDING.address, value: bal - reserve, gasLimit: 21000n, maxFeePerGas: maxFee, maxPriorityFeePerGas: fd.maxPriorityFeePerGas ?? 1_000_000n })).hash);
  } catch (e: any) { line(`   sweep ${label} skipped: ${String(e?.shortMessage ?? e?.message).slice(0, 80)}`); }
}

mkdirSync(dirname(LOG), { recursive: true });
line(`\n════════ staging-config-cap-test ${now()} ════════`);
line(`funding ${FUNDING.address} ETH ${ethers.formatEther(await p.getBalance(FUNDING.address))}`);
let st: any = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
let mgr: any, dep: any;
if (st && st.phase !== "done" && process.env.RESUME === "1") {
  mgr = new ethers.Wallet(st.mgrPk, p); dep = new ethers.Wallet(st.depPk, p);
  line(`[${now()}] ── RESUMING vault ${mgr.address} (phase ${st.phase}, configs ${await nCfg(mgr.address)}) ──`);
} else {
  mgr = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, p); dep = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, p);
  st = { manager: mgr.address, mgrPk: mgr.privateKey, depPk: dep.privateKey, createdAt: Date.now(), phase: "minting" };
  writeFileSync(STATE, JSON.stringify(st, null, 1), { mode: 0o600 });   // keys on disk before any tx → always recoverable
  line(`[${now()}] ── minting vault ${mgr.address} (seed $${SEED}, dep $${DEP}, 10% APY, exit 2.0) — keys → ${STATE} ──`);
  await ensureFunded(p, mgr.address, process.env.MGR_ETH!, String(SEED + 25));
  if (!(await createVault(p, { manager: mgr, seedUsd: SEED, fields: FIELDS, log: line }))) throw new Error("vault did not go live");
  await ensureFunded(p, dep.address, process.env.DEP_ETH!, String(DEP + 20));
  if (!(await depositTo(p, { managerAddr: mgr.address, dep, amountUsd: DEP, expectDepositors: 1, settleMs: 8000, log: line }))) throw new Error("deposit not applied");
  st.phase = "live"; writeFileSync(STATE, JSON.stringify(st, null, 1), { mode: 0o600 });
}

let pairGas = 0;
for (const target of POINTS) {
  const have = await nCfg(mgr.address);
  if (target > have) { await ensureFunded(p, mgr.address, process.env.MGR_ETH!, "0"); const t0 = Date.now(); pairGas = await addConfigs(mgr, target - have, have); line(`   added ${target - have} configs in ${((Date.now() - t0) / 1000).toFixed(0)}s (avg ${pairGas.toFixed(0)} gas per initiate+finalize) → ${await nCfg(mgr.address)}`); }
  await measure(mgr, dep, POINTS.length === 1 ? `DORMANT vault, first activity after ${target - 1} configs` : `point ${target}`);
}
check("config-cap-reached", (await nCfg(mgr.address)) === 100, `configuration history length = ${await nCfg(mgr.address)}`);

// 101st must be refused at initiate
{ const c = new ethers.Contract(PROVIDER, VP_ABI, mgr) as any; let res = "ACCEPTED";
  try { await c.initiateManagedAccountUpgrade.staticCall(encodeCfg(mgr.address, { ...FIELDS, maximumNetDepositsInPips: FIELDS.maximumNetDepositsInPips + 999n })); }
  catch (e: any) { const data = e?.data ?? e?.info?.error?.data; try { const d = iface.parseError(data); res = `${d?.name}(${d?.args?.join(",")})`; } catch { res = e?.shortMessage ?? "reverted"; } }
  check("101st-config-refused", /MaximumVaultConfigurationsReached\(100\)/.test(res), `initiateManagedAccountUpgrade at 100 configs → ${res}`); }

// slopes vs Foundry (8,607 gas/config apply-deposit; ~5,100 gas/config withdraw-enqueue)
const r1 = rows[0], r100 = rows[rows.length - 1];
const slope = (a: number | null, b: number | null) => (a != null && b != null) ? (b - a) / (r100.configs - r1.configs) : null;
const sDep = slope(r1.depositApply, r100.depositApply), sW = slope(r1.withdrawEnqueue, r100.withdrawEnqueue), sV = slope(r1.balanceView, r100.balanceView), sWA = slope(r1.withdrawApply, r100.withdrawApply);
line(`\n   slopes (gas per extra config): deposit-apply ${sDep?.toFixed(0) ?? "n/a"}  withdraw-enqueue ${sW?.toFixed(0) ?? "n/a"}  withdraw-apply ${sWA?.toFixed(0) ?? "n/a"}  balance-view ${sV?.toFixed(0) ?? "n/a"}`);
if (rows.length > 1 && sDep != null) check("deposit-apply-walk-linear", sDep > 3000 && sDep < 15000, `${sDep.toFixed(0)} gas/config live vs 8,607 in Foundry`);
if (rows.length > 1 && sWA != null) check("withdraw-apply-flat", Math.abs(sWA) < 500, `${sWA.toFixed(0)} gas/config (apply does not re-walk)`);
if (r100.depositApply != null) check("dispatcher-apply-under-budget-at-cap", r100.depositApply < 4_000_000, `dormant-vault applyPendingDeposit after 99 configs = ${r100.depositApply} gas = ${((r100.depositApply / 4_000_000) * 100).toFixed(1)}% of a 4M dispatcher budget (Foundry provider-only: 890,103)`);
check("withdraw-enqueue-under-budget-at-cap", r100.withdrawEnqueue < 4_000_000, `${r100.withdrawEnqueue} gas at 100 configs`);

// cleanup: exit (measure real gas at 100 configs) → CPP → withdrawExit (measure) → sweep
line(`\n[${now()}] ── cleanup: exit at ${await nCfg(mgr.address)} configs ──`);
const eavPre = Number(await ex.loadQuoteQuantityAvailableForExitWithdrawal(mgr.address)) / 1e8;
const cM = new ethers.Contract(PROVIDER, VP_ABI, mgr) as any, cD = new ethers.Contract(PROVIDER, VP_ABI, dep) as any;
const rx = await waitRc((await cM.exitWallet(mgr.address, { gasLimit: 3_000_000 })).hash); line(`   exitWallet gasUsed ${Number(rx.gasUsed)}  (EAV_pre ${eavPre.toFixed(4)})`);
const cpp = Number(await ex.chainPropagationPeriodInS()); await sleep((cpp + 30) * 1000);
const b0 = await usdc.balanceOf(dep.address) + await usdc.balanceOf(mgr.address);
const rd = await waitRc((await cD.withdrawExit(mgr.address, dep.address, { gasLimit: 4_000_000 })).hash); line(`   withdrawExit(depositor) gasUsed ${Number(rd.gasUsed)} at 100 configs (Foundry: 301,915 @100)`);
const rm = await waitRc((await cM.withdrawExit(mgr.address, mgr.address, { gasLimit: 2_500_000 })).hash); line(`   withdrawExit(manager) gasUsed ${Number(rm.gasUsed)} (flat; no interest walk)`);
const got = Number(await usdc.balanceOf(dep.address) + await usdc.balanceOf(mgr.address) - b0) / 1e6;
check("exit-conservation-at-cap", Math.abs(got - eavPre) < 0.02, `recovered $${got.toFixed(4)} vs EAV_pre $${eavPre.toFixed(4)}`);
check("depositor-withdrawExit-under-block-at-cap", Number(rd.gasUsed) < 30_000_000, `${Number(rd.gasUsed)} gas`);
await sweep(dep, "depositor"); await sweep(mgr, "manager");
st.phase = "done"; writeFileSync(STATE, JSON.stringify(st, null, 1), { mode: 0o600 });
line(`\n   TABLE configs | deposit-apply | withdraw-enqueue | withdraw-apply | balance-view | exitWallet-est`);
for (const r of rows) line(`   ${String(r.configs).padStart(6)} | ${String(r.depositApply ?? "-").padStart(13)} | ${String(r.withdrawEnqueue).padStart(16)} | ${String(r.withdrawApply ?? "-").padStart(14)} | ${String(r.balanceView).padStart(12)} | ${String(r.exitEstimate ?? "-").padStart(14)}`);
const pass = results.filter((r) => r.pass).length;
line(`\nRESULT: ${pass}/${results.length} passed — funding ETH ${ethers.formatEther(await p.getBalance(FUNDING.address))}`);
