/**
 * staging-reduceonly-test.ts — LIVE (staging): what happens to ORDER PLACEMENT while a depositor
 * withdrawal sits unapplied in the vault's queue.
 *
 * README (contracts, "Withdrawal Queue"):
 *   "If a withdrawal cannot be applied immediately, off-chain systems place the manager wallet in
 *    reduce only mode. In reduce only mode, no orders are accepted that may increase the absolute
 *    quantity of any position, and all such standing orders are proactively canceled. Reduce only
 *    mode is removed on withdrawal application."
 *
 * That is OFF-CHAIN behaviour, so only a live run can confirm it. Setup:
 *   manager goes LONG TAO-USD (IMF 20% → a small notional locks most of the vault's collateral)
 *   against our own counterparty, leaving free collateral BELOW the depositor's withdrawal size.
 *   The depositor then withdraws more than that → the withdrawal cannot be applied → queue.
 *
 * Measured, before vs after the withdrawal enters the queue:
 *   1. resting INCREASE order (buy, same side as the long) — proactively cancelled?
 *   2. resting REDUCE order (sell)                          — left alone?
 *   3. NEW increase order                                    — rejected? with what error?
 *   4. NEW reduce order                                      — still accepted?
 *   5. reduce-only lifted once the withdrawal applies (manager closes the position to free margin)
 *
 *   npx tsx src/staging-reduceonly-test.ts    (run under flock /tmp/staging-lab.lock)
 */
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { dirname } from "path";
const ENVF = "/home/user/code/kperps-test/ikon-vaultgen/docker/staging/.env.staging";
for (const l of readFileSync(ENVF, "utf8").split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }
process.env.STRATEGY ??= "market-making";
process.env.MGR_ETH = "0.0002"; process.env.DEP_ETH = "0.0001";

const { ethers } = await import("ethers");
const kperps = await import("@katanaperps/katana-perps-sdk");
const { v1: uuidv1 } = await import("uuid");
const { provider, ensureFunded, createVault, depositTo, waitReceipt, rpcRetry, USDC_DECIMALS } = await import("./vault.js");
const { withdrawOnChain } = await import("./withdraw-onchain.js");
const { buildClient } = await import("./client.js");

const LOG = "/home/user/code/kperps-test/foundry-tests/ops/logs/staging-reduceonly-test.log";
// Per-RUN state file. A fixed filename is a trap: a later run overwrites the previous run's keys
// and strands whatever those wallets still hold (cost ~$400 on 2026-09-22).
const RUN_ID = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const STATE = `/home/user/code/kperps-test/foundry-tests/ops/staging-reduceonly-state-${RUN_ID}.json`;
const PROVIDER = process.env.VAULT_PROVIDER!, EXCHANGE = process.env.EXCHANGE_CONTRACT!, QUOTE = process.env.QUOTE_TOKEN!;
const ADAPTER = process.env.DEPOSIT_ADAPTER ?? process.env.LOCAL_DEPOSIT_ADAPTER!;
const FUNDING = new ethers.Wallet(process.env.FUNDING_WALLET_KEY!);
const MK = process.env.MANAGER_API_KEY!, MS = process.env.MANAGER_API_SECRET!;
const DK = process.env.DEPOSITOR_API_KEY!, DS = process.env.DEPOSITOR_API_SECRET!;
const p = provider();
const pip = (v: number) => BigInt(Math.round(v * 1e8));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const line = (s: string) => { console.log(s); appendFileSync(LOG, s + "\n"); };
const waitRc = async (h: string) => { const r = await p.waitForTransaction(h, 1, 180_000); if (!r || r.status !== 1) throw new Error(`tx ${h} status ${r?.status}`); return r; };
const results: { name: string; pass: boolean }[] = [];
const check = (name: string, pass: boolean, detail: string) => { results.push({ name, pass }); line(`   ${pass ? "✓" : "✗"} ${name} — ${detail}`); };

const MARKET = "TAO-USD";
const SEED = 150, DEP = 100, CP_COLLATERAL = 0;   // book is live; no counterparty fill needed
const FIELDS = {
  interestMultiplierInPips: 0n, maximumNetDepositsInPips: pip(5000),
  maximumTotalOwedQuantityAvailableForExitWithdrawalMultiplierNeededToInitiateExitInPips: pip(2.00),
  minimumTotalOwedQuantityAvailableForExitWithdrawalMultiplierToAllowManagerWalletWithdrawalInPips: pip(0.50),
  minimumUnappliedWithdrawalAgeInSNeededToInitiateExit: 86400,   // keep the queue-age exit out of the way
  withdrawalLimitPercentForDepositorsInPips: pip(1.00), withdrawalLimitPercentForVaultInPips: pip(1.00),
};
const VP_ABI = [
  "function loadVaultSummary(address) view returns ((bool,bool,bool,bool,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64))",
  "function loadVaultBalanceForWalletSummary(address,address) view returns ((uint64,uint64,uint64,uint64,uint64,uint64,uint64))",
  "function loadVaultWithdrawQueueLength(address) view returns (uint256)",
  "function exitWallet(address)", "function withdrawExit(address,address)",
];
const vp = new ethers.Contract(PROVIDER, VP_ABI, p) as any;
const usdc = new ethers.Contract(QUOTE, ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)"], p) as any;
const pub = new kperps.RestPublicClient({ baseURL: process.env.BASE_URL!, sandbox: true });

const queueLen = async (m: string) => Number(await vp.loadVaultWithdrawQueueLength(m));
const owedOf = async (m: string, w: string) => Number((await vp.loadVaultBalanceForWalletSummary(m, w))[3]) / 1e8;

/** Plain (non-vault) exchange deposit, for the counterparty. */
async function depositToWallet(w: any, amountUsd: number) {
  const amt = ethers.parseUnits(amountUsd.toFixed(2), USDC_DECIMALS);
  const vb = usdc.connect(w) as any;
  await waitReceipt(p, ((await rpcRetry("approve", () => vb.approve(ADAPTER, amt))) as any).hash);
  const payload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint8", "tuple(uint32,address)"],
    [kperps.DepositBridgeAdapterPayloadType.depositToWallet, [Number(process.env.LZ_ENDPOINT_ID ?? 40448), w.address]],
  );
  const adapter = new ethers.Contract(ADAPTER, ["function deposit(uint256,bytes)"], w) as any;
  await waitReceipt(p, ((await rpcRetry("adapter deposit", () => adapter.deposit(amt, payload))) as any).hash);
}
async function place(c: any, side: "buy" | "sell", qty: string, price: string | null, tif?: string): Promise<string> {
  try {
    const o: any = { market: MARKET, side: side === "buy" ? kperps.OrderSide.buy : kperps.OrderSide.sell,
      type: price ? kperps.OrderType.limit : kperps.OrderType.market, quantity: qty,
      ...(price ? { price } : {}), ...(tif ? { timeInForce: tif } : {}), selfTradePrevention: "cb",
      wallet: c.wallet, nonce: uuidv1() };
    const r = await c.auth.createOrder(o);
    return `OK:${r?.orderId ?? "filled"}`;
  } catch (e: any) { return `${e?.response?.data?.code ?? "ERR"}: ${(e?.response?.data?.message ?? e?.message ?? "").slice(0, 90)}`; }
}
async function openOrders(c: any): Promise<any[]> {
  try { const r = await c.auth.getOrders({ wallet: c.wallet, nonce: uuidv1(), limit: 100 }); return Array.isArray(r) ? r : []; } catch { return []; }
}
async function position(c: any): Promise<number> {
  try { const r: any = await c.auth.getPositions({ wallet: c.wallet, nonce: uuidv1() });
    const list = Array.isArray(r) ? r : (r?.positions ?? []);
    const t = list.find((x: any) => x.market === MARKET); return t ? Number(t.quantity) : 0;
  } catch { return 0; }
}
async function freeCollateral(c: any): Promise<{ equity: number; free: number }> {
  try { const w: any = await c.auth.getWallets({ wallet: c.wallet, nonce: uuidv1() });
    const x = Array.isArray(w) ? w[0] : w;
    return { equity: Number(x?.equity ?? 0), free: Number(x?.freeCollateral ?? x?.availableCollateral ?? 0) };
  } catch { return { equity: 0, free: 0 }; }
}
async function sweep(w: any, label: string) {
  try { const fd = await p.getFeeData(); const maxFee = (fd.maxFeePerGas ?? 3_000_000n) * 2n;
    const u = await usdc.balanceOf(w.address); if (u > 0n) await waitRc((await (usdc.connect(w) as any).transfer(FUNDING.address, u, { gasLimit: 80_000n, maxFeePerGas: maxFee })).hash);
    const b = await p.getBalance(w.address), reserve = 21000n * maxFee + 1_000_000_000_000n;
    if (b > reserve * 2n) await waitRc((await w.sendTransaction({ to: FUNDING.address, value: b - reserve, gasLimit: 21000n, maxFeePerGas: maxFee, maxPriorityFeePerGas: fd.maxPriorityFeePerGas ?? 1_000_000n })).hash);
  } catch (e: any) { line(`   sweep ${label} skipped: ${String(e?.shortMessage ?? e?.message).slice(0, 70)}`); }
}
const saveState = (o: any) => { const prev = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {}; writeFileSync(STATE, JSON.stringify({ ...prev, ...o }, null, 1), { mode: 0o600 }); };

mkdirSync(dirname(LOG), { recursive: true });
line(`\n════════ staging-reduceonly-test ${now()} ════════`);
const mkt = (await pub.getMarkets()).find((m: any) => m.market === MARKET)!;
const idx = Number(mkt.indexPrice), imf = Number(mkt.initialMarginFraction);
line(`funding ETH ${ethers.formatEther(await p.getBalance(FUNDING.address))}   ${MARKET} index ${idx} IMF ${(imf * 100).toFixed(0)}% step ${mkt.stepSize} takerMin ${mkt.takerOrderMinimum}`);

const mgr = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, p);
const dep = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, p);
const cp  = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, p);
saveState({ manager: mgr.address, mgrPk: mgr.privateKey, depPk: dep.privateKey, cpPk: cp.privateKey, createdAt: Date.now(), phase: "minting" });
const mgrC = buildClient(MK, MS, mgr.privateKey), depC = buildClient(DK, DS, dep.privateKey), cpC = buildClient(DK, DS, cp.privateKey);

line(`\n[${now()}] ── setup: vault (seed $${SEED} + depositor $${DEP}) and counterparty ($${CP_COLLATERAL}) ──`);
await ensureFunded(p, mgr.address, process.env.MGR_ETH!, String(SEED + 25));
if (!(await createVault(p, { manager: mgr, seedUsd: SEED, fields: FIELDS, log: line }))) throw new Error("vault did not go live");
for (const [w, c, name] of [[mgr, mgrC, "manager"], [dep, depC, "depositor"], [cp, cpC, "counterparty"]] as const) {
  try { await c.auth.associateWallet({ wallet: w.address, nonce: uuidv1() }); line(`   associated ${name}`); } catch (e: any) { line(`   associate ${name}: ${(e?.response?.data?.code ?? e?.message ?? "").toString().slice(0, 50)}`); }
}
await ensureFunded(p, dep.address, process.env.DEP_ETH!, String(DEP + 5));
if (!(await depositTo(p, { managerAddr: mgr.address, dep, amountUsd: DEP, expectDepositors: 1, settleMs: 8000, log: () => {} }))) throw new Error("depositor deposit not applied");
line(`   depositor $${DEP} applied (owed $${(await owedOf(mgr.address, dep.address)).toFixed(2)})`);
line(`   (no counterparty needed — ${MARKET} has a live book)`);
saveState({ phase: "funded" });

// ── manager takes a LONG that locks most of the vault's collateral ───────────
// Take the LIVE book with market orders in chunks. (An earlier version rested a counterparty
// limit and tried to cross it — the fill never happened; a market order fills instantly.)
const mgrEq0 = (await freeCollateral(mgrC)).equity;
const FREE_TARGET = 40;                       // leave well under the $100 withdrawal
const chunk = Math.max(Number(mkt.takerOrderMinimum), Math.floor((mgrEq0 * 0.25 / imf / idx) * 1000) / 1000);
line(`\n[${now()}] ── manager buys ${MARKET} on the live book until free collateral < $${FREE_TARGET} (equity $${mgrEq0.toFixed(2)}, IMF ${(imf * 100).toFixed(0)}%) ──`);
for (let i = 0; i < 10; i++) {
  const fcNow = await freeCollateral(mgrC);
  if (fcNow.free < FREE_TARGET) break;
  const want = Math.max(Number(mkt.takerOrderMinimum), Math.min(chunk, Math.floor(((fcNow.free - FREE_TARGET * 0.6) / imf / idx) * 1000) / 1000));
  const r = await place(mgrC, "buy", want.toFixed(8), null);          // market order
  line(`   market buy ${want.toFixed(3)} → ${r}   (free was $${fcNow.free.toFixed(2)})`);
  if (!r.startsWith("OK:")) break;
  await sleep(5000);
}
const pos = await position(mgrC); const fc = await freeCollateral(mgrC);
line(`   manager position ${pos} ${MARKET}   equity $${fc.equity.toFixed(2)}  free $${fc.free.toFixed(2)}`);
check("manager-position-open", pos > 0 && fc.free < DEP,
  `LONG ${pos} ${MARKET}; free collateral $${fc.free.toFixed(2)} is below the $${DEP} withdrawal about to be queued`);
saveState({ phase: "positioned" });

// ── resting orders on both sides, away from the book so they do not fill ─────
const buyPx = (Math.round(idx * 0.90 * 100) / 100).toFixed(8);    // increase (same side as the long)
const sellPx = (Math.round(idx * 1.10 * 100) / 100).toFixed(8);   // reduce
const qSmall = Number(mkt.takerOrderMinimum).toFixed(8);   // API demands 8dp quantities
line(`\n[${now()}] ── resting orders BEFORE the withdrawal ──`);
line(`   increase (buy ${qSmall} @ ${buyPx}): ${await place(mgrC, "buy", qSmall, buyPx, kperps.TimeInForce.gtx)}`);
line(`   reduce   (sell ${qSmall} @ ${sellPx}): ${await place(mgrC, "sell", qSmall, sellPx, kperps.TimeInForce.gtx)}`);
await sleep(4000);
const before = await openOrders(mgrC);
const nBuyBefore = before.filter((o) => o.side === "buy").length, nSellBefore = before.filter((o) => o.side === "sell").length;
line(`   manager open orders: ${before.length} (${nBuyBefore} buy / ${nSellBefore} sell)`);
check("orders-rest-before-withdrawal", nBuyBefore >= 1 && nSellBefore >= 1, `${nBuyBefore} increase + ${nSellBefore} reduce orders resting while no withdrawal is queued`);

// ── depositor withdraws more than the manager's free collateral ──────────────
const owed = await owedOf(mgr.address, dep.address);
const want = Math.floor((owed - 0.05) * 100) / 100;
line(`\n[${now()}] ── depositor withdraws $${want.toFixed(2)} (free collateral is only $${fc.free.toFixed(2)} → cannot be applied) ──`);
let wres = "sent";
try { await waitRc(await withdrawOnChain(p, dep, mgr.address, want)); } catch (e: any) { wres = String(e?.shortMessage ?? e?.message).slice(0, 80); }
line(`   withdrawal submitted: ${wres}`);
await sleep(8000);
const qlen = await queueLen(mgr.address);
check("withdrawal-sits-in-queue", qlen > 0, `loadVaultWithdrawQueueLength = ${qlen} — the dispatcher cannot apply it against $${fc.free.toFixed(2)} of free collateral`);
saveState({ phase: "queued" });

// ── the question: what happens to orders now? ────────────────────────────────
line(`\n[${now()}] ── watching the manager's orders for 90s while the withdrawal sits queued ──`);
let cancelledBuy = false, keptSell = false, snapshots: string[] = [];
for (let i = 0; i < 15; i++) {
  await sleep(6000);
  const o = await openOrders(mgrC);
  const b = o.filter((x) => x.side === "buy").length, s = o.filter((x) => x.side === "sell").length;
  snapshots.push(`${(i + 1) * 6}s:${b}b/${s}s`);
  if (b === 0 && nBuyBefore > 0) { cancelledBuy = true; keptSell = s > 0; break; }
}
line(`   order counts over time: ${snapshots.join("  ")}`);
const after = await openOrders(mgrC);
const nBuyAfter = after.filter((o) => o.side === "buy").length, nSellAfter = after.filter((o) => o.side === "sell").length;
check("standing-INCREASE-order-cancelled", cancelledBuy,
  cancelledBuy ? `the resting buy (increase) was proactively cancelled while the withdrawal sat queued — reduce-only is enforced`
               : `the resting buy is STILL OPEN after 90s (${nBuyAfter} buy / ${nSellAfter} sell) — reduce-only was NOT applied`);
check("standing-REDUCE-order-kept", nSellAfter > 0,
  nSellAfter > 0 ? `the resting sell (reduce) survived — only increase-side orders are pulled` : `the reduce-side order was also removed`);

line(`\n[${now()}] ── new orders while the withdrawal is queued ──`);
const newIncrease = await place(mgrC, "buy", qSmall, buyPx, kperps.TimeInForce.gtx);
const newReduce  = await place(mgrC, "sell", qSmall, sellPx, kperps.TimeInForce.gtx);
line(`   new INCREASE (buy):  ${newIncrease}`);
line(`   new REDUCE   (sell): ${newReduce}`);
check("new-INCREASE-order-rejected", !newIncrease.startsWith("OK:"),
  newIncrease.startsWith("OK:") ? `accepted — increase orders are NOT blocked` : `rejected → ${newIncrease}`);
check("new-REDUCE-order-accepted", newReduce.startsWith("OK:"),
  newReduce.startsWith("OK:") ? `accepted — the manager can still de-risk` : `rejected → ${newReduce}`);

// ── free the collateral so the withdrawal applies; reduce-only should lift ───
line(`\n[${now()}] ── manager closes the position (a reduce order) so the withdrawal can apply ──`);
line(`   manager market-sells ${Math.abs(pos).toFixed(3)} to close: ${await place(mgrC, "sell", Math.abs(pos).toFixed(8), null)}`);
let applied = false;
for (let i = 0; i < 30; i++) { await sleep(6000); if ((await queueLen(mgr.address)) === 0) { applied = true; break; } }
const posAfter = await position(mgrC);
check("withdrawal-applies-once-collateral-frees", applied, applied ? `queue drained to 0 after the position closed (position now ${posAfter})` : `still queued after 180s (position ${posAfter})`);
if (applied) {
  await sleep(8000);
  const relist = await place(mgrC, "buy", qSmall, buyPx, kperps.TimeInForce.gtx);
  line(`   increase order after apply: ${relist}`);
  check("reduce-only-lifted-after-apply", relist.startsWith("OK:"), relist.startsWith("OK:") ? `an increase order is accepted again — reduce-only was released` : `still rejected → ${relist}`);
}

// ── cleanup ─────────────────────────────────────────────────────────────────
line(`\n[${now()}] ── cleanup ──`);
for (const [c, n] of [[mgrC, "manager"], [cpC, "cp"]] as const) { try { await c.auth.cancelOrders({ wallet: c.wallet, nonce: uuidv1() }); line(`   cancelled ${n} orders`); } catch {} }
try {
  const cM = new ethers.Contract(PROVIDER, VP_ABI, mgr) as any;
  await cM.exitWallet.staticCall(mgr.address);
  const ex = new ethers.Contract(EXCHANGE, ["function chainPropagationPeriodInS() view returns (uint256)"], p) as any;
  await waitRc((await cM.exitWallet(mgr.address, { gasLimit: 2_000_000 })).hash);
  const cpp = Number(await ex.chainPropagationPeriodInS()); line(`   exited; CPP ${cpp}s…`); await sleep((cpp + 30) * 1000);
  for (const w of [dep, mgr]) { const c = new ethers.Contract(PROVIDER, VP_ABI, w) as any;
    try { await waitRc((await c.withdrawExit(mgr.address, w.address, { gasLimit: 2_500_000 })).hash); } catch (e: any) { line(`   withdrawExit ${w.address.slice(0, 8)}…: ${String(e?.shortMessage ?? e?.message).slice(0, 60)}`); } }
} catch (e: any) {
  line(`   exit not possible (${String(e?.shortMessage ?? e?.message).slice(0, 60)}) — draining via manager withdrawal instead`);
  // With totalOwed at 0 the EAV trigger (EAV < mult × owed) can never fire, but the manager floor
  // is also 0, so the manager can simply withdraw the whole balance.
  try {
    const exR = new ethers.Contract(EXCHANGE, ["function loadQuoteQuantityAvailableForExitWithdrawal(address) view returns (int64)"], p) as any;
    for (let i = 0; i < 6; i++) {
      const eav = Number(await exR.loadQuoteQuantityAvailableForExitWithdrawal(mgr.address)) / 1e8;
      const locked = Number((await vp.loadVaultSummary(mgr.address))[8]) / 1e8;
      const take = Math.floor((eav - locked - 0.02) * 100) / 100;
      if (take < 1) break;
      line(`   manager withdraws $${take.toFixed(2)} (EAV $${eav.toFixed(2)})`);
      try { await waitRc(await withdrawOnChain(p, mgr, mgr.address, take)); } catch (e2: any) { line(`     ${String(e2?.shortMessage ?? e2?.message).slice(0, 70)}`); break; }
      await sleep(20000);
    }
  } catch (e2: any) { line(`   drain failed: ${String(e2?.shortMessage ?? e2?.message).slice(0, 70)} — keys in ${STATE}`); }
}
try { const w: any = await cpC.auth.getWallets({ wallet: cp.address, nonce: uuidv1() }); line(`   cp equity left: $${Number((Array.isArray(w) ? w[0] : w)?.equity ?? 0).toFixed(2)}`); } catch {}
for (const [w, n] of [[dep, "depositor"], [mgr, "manager"], [cp, "cp"]] as const) await sweep(w, n);
saveState({ phase: "done" });
const pass = results.filter((r) => r.pass).length;
line(`\nRESULT: ${pass}/${results.length} passed — funding ETH ${ethers.formatEther(await p.getBalance(FUNDING.address))}`);
