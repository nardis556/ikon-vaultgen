/**
 * staging-lab.ts — unified LIVE vault lifecycle on STAGING. ONE exit-eligible vault per ~2h window,
 * REUSED for many test ticks, then EXITED near the window's end.
 *
 *   tick decides: MINT (no live vault & rate-limit elapsed) | REUSE+battery (age < WINDOW_MIN) |
 *                 FINALIZE=exit lifecycle (age >= WINDOW_MIN) | RESUME (a prior exit half-finished).
 *
 * Reuse battery (non-terminal, reads + manager/depositor-signed, no admin):
 *   invariants · config-upgrade-delay0 · downgrade-bypass-live · dispatcher-withdrawal (real apply).
 * Finalize: snapshot EAV → exitWallet → wait 60s CPP → withdrawExit(dep+mgr) → conservation → sweep.
 *
 *   npx tsx src/staging-lab.ts        (RATE_MIN=0 forces an immediate mint; FINALIZE=1 forces exit)
 */
import { readFileSync, appendFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const ENVF = "/home/user/code/kperps-test/ikon-vaultgen/docker/staging/.env.staging";
for (const l of readFileSync(ENVF, "utf8").split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }
process.env.STRATEGY ??= "market-making";
process.env.MGR_ETH = "0.00004"; process.env.DEP_ETH = "0.00003";

const { ethers } = await import("ethers");
const { encodeFixedIncomeVaultConfigurationFields } = await import("@katanaperps/katana-perps-sdk");
const { provider, ensureFunded, createVault, depositTo, readVault, vaultBalance } = await import("./vault.js");
const { withdrawOnChain } = await import("./withdraw-onchain.js");

const STATE = "/home/user/code/kperps-test/foundry-tests/ops/staging-lab-state.json";
const LOG = "/home/user/code/kperps-test/foundry-tests/ops/logs/staging-lab.log";
const WINDOW_MIN = Number(process.env.WINDOW_MIN ?? 105);   // exit once the vault is this old
const RATE_MIN   = Number(process.env.RATE_MIN ?? 115);     // min minutes between mints
const SEED = 120, DEP = 250, DEP2 = 100, CPP_MARGIN_S = 30;   // two depositors → shared vault budget + pro-rata exit payout
const APY = 0.10; // must match FIELDS.interestMultiplierInPips
// A mint costs ≈0.00014 ETH (2 wallets funded + gas top-ups + txs); never start one without ~3× headroom.
const MIN_MINT_ETH = ethers.parseEther(process.env.MIN_MINT_ETH ?? "0.0005");
const PROVIDER = process.env.VAULT_PROVIDER!, EXCHANGE = process.env.EXCHANGE_CONTRACT!, QUOTE = process.env.QUOTE_TOKEN!;
const FUNDING = new ethers.Wallet(process.env.FUNDING_WALLET_KEY!);
const p = provider();
const pip = (v: number) => BigInt(Math.round(v * 1e8));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const line = (s: string) => { console.log(s); appendFileSync(LOG, s + "\n"); };
const waitRc = async (h: string) => { const r = await p.waitForTransaction(h, 1, 180_000); if (!r || r.status !== 1) throw new Error(`tx ${h} status ${r?.status}`); return r; };

// exit-eligible while solvent (exitMult 2.0, depositor-heavy) + BINDING 10%/10% caps for the bypass test
const FIELDS = {
  interestMultiplierInPips: pip(0.10), maximumNetDepositsInPips: pip(5000),
  maximumTotalOwedQuantityAvailableForExitWithdrawalMultiplierNeededToInitiateExitInPips: pip(2.00),
  minimumTotalOwedQuantityAvailableForExitWithdrawalMultiplierToAllowManagerWalletWithdrawalInPips: pip(1.00),
  minimumUnappliedWithdrawalAgeInSNeededToInitiateExit: 3600,
  withdrawalLimitPercentForDepositorsInPips: pip(0.10), withdrawalLimitPercentForVaultInPips: pip(0.10),
};
const encodeCfg = (mgr: string, f: any) => encodeFixedIncomeVaultConfigurationFields({ managerWallet: mgr, effectiveTimestampInS: 0, ...f });
const UP_ABI = ["function withdrawalLimitWindowSizeInS() view returns (uint64)","function initiateManagedAccountUpgrade(bytes payload)","function finalizeManagedAccountUpgrade()","function cancelManagedAccountUpgrade()","function loadVaultConfigurationsLength(address) view returns (uint256)","function loadVaultSummary(address) view returns ((bool,bool,bool,bool,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64))","function loadVaultBalanceForWalletSummary(address,address) view returns ((uint64,uint64,uint64,uint64,uint64,uint64,uint64))"];
const EXIT_ABI = ["function exitWallet(address)","function withdrawExit(address,address)","function loadVaultSummary(address) view returns ((bool,bool,bool,bool,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64))"];
const EX_ABI = ["function loadQuoteQuantityAvailableForExitWithdrawal(address) view returns (int64)","function chainPropagationPeriodInS() view returns (uint256)"];
const usdcRead = new ethers.Contract(QUOTE, ["function balanceOf(address) view returns (uint256)"], p);

async function topUpGas(addr: string, targetEth = "0.00006") {
  const bal = await p.getBalance(addr); if (bal >= ethers.parseEther(targetEth)) return;
  const f = new ethers.Wallet(process.env.FUNDING_WALLET_KEY!, p); const fd = await p.getFeeData();
  await waitRc((await f.sendTransaction({ to: addr, value: ethers.parseEther(targetEth) - bal, gasLimit: 21000n, maxFeePerGas: (fd.maxFeePerGas ?? 3_000_000n) * 2n, maxPriorityFeePerGas: fd.maxPriorityFeePerGas ?? 1_000_000n })).hash);
  line(`   topped gas ${addr.slice(0,10)}… → ${targetEth} ETH`);
}
async function sweepAll(pk: string, label: string) {
  try { const w = new ethers.Wallet(pk, p); const vb = new ethers.Contract(QUOTE, ["function balanceOf(address) view returns (uint256)","function transfer(address,uint256) returns (bool)"], w) as any;
    const fd = await p.getFeeData(); const maxFee = (fd.maxFeePerGas ?? 3_000_000n) * 2n; const u = await vb.balanceOf(w.address);
    if (u > 0n) { await waitRc((await vb.transfer(FUNDING.address, u, { gasLimit: 80_000n, maxFeePerGas: maxFee })).hash); line(`   swept ${ethers.formatUnits(u,6)} vbUSDC from ${label}`); }
    const bal = await p.getBalance(w.address); const reserve = 21000n * maxFee + 1_000_000_000_000n;
    if (bal > reserve * 2n) { await waitRc((await w.sendTransaction({ to: FUNDING.address, value: bal - reserve, gasLimit: 21000n, maxFeePerGas: maxFee, maxPriorityFeePerGas: fd.maxPriorityFeePerGas ?? 1_000_000n })).hash); line(`   swept ${ethers.formatEther(bal-reserve)} ETH from ${label}`); }
  } catch (e: any) { line(`   sweep ${label} skipped: ${String(e?.shortMessage ?? e?.message ?? e).slice(0,80)}`); }
}
const results: {name:string;pass:boolean}[] = [];
const check = (name: string, pass: boolean, detail: string) => { results.push({name,pass}); line(`   ${pass?"✓":"✗"} ${name} — ${detail}`); };
const saveState = (o: any) => writeFileSync(STATE, JSON.stringify(o, null, 2), { mode: 0o600 });

// ── battery ──
async function battery(st: any) {
  const mgr = new ethers.Wallet(st.mgrPk, p), depAddr = new ethers.Wallet(st.depPk).address;
  const dep2Addr: string | undefined = st.dep2Pk ? new ethers.Wallet(st.dep2Pk).address : undefined;
  await topUpGas(mgr.address);
  const c = new ethers.Contract(PROVIDER, UP_ABI, mgr) as any;
  const sumFor = async (addr: string) => { const b = await c.loadVaultBalanceForWalletSummary(st.manager, addr); return { costBasis: Number(b[0]) / 1e8, owed: Number(b[3]) / 1e8, locked: Number(b[2]) / 1e8, avail: Number(b[5]) / 1e8, windowEnd: Number(b[6]) }; };
  const sum = () => sumFor(depAddr);
  const vaultTotal = async () => Number((await c.loadVaultSummary(st.manager))[12]) / 1e8;
  // invariants
  const v = await readVault(p, st.manager, dep2Addr ? [depAddr, dep2Addr] : [depAddr]) as any;
  const expDeps = dep2Addr ? 2 : 1;
  check("invariants", v.isActive && !v.isExited && !v.isLiquidated && Number(v.numDepositorWallets) === expDeps, `active=${v.isActive} exited=${v.isExited} liq=${v.isLiquidated} totalOwed=${(v.totalOwedQuantity ?? v.totalOwed)?.toFixed?.(4)} numDeps=${v.numDepositorWallets}/${expDeps}`);
  // interest accrual sanity: owed − costBasis should be the continuous-compound interest on ~costBasis since mint (loose ½×–2× band)
  { const s = await sum(); const years = (Date.now() - st.createdAt) / 1000 / 31_557_600; const theo = s.costBasis * (Math.exp(APY * years) - 1); const accrued = s.owed - s.costBasis;
    const impliedApy = years > 0 && s.costBasis > 0 ? Math.log(s.owed / s.costBasis) / years : 0;
    if (theo > 0.0005) check("interest-accrual", accrued >= 0.5 * theo - 0.0005 && accrued <= 2 * theo + 0.0005, `owed ${s.owed.toFixed(6)} − costBasis ${s.costBasis.toFixed(4)} = ${accrued.toFixed(6)} vs theoretical ${theo.toFixed(6)} @${(APY * 100).toFixed(0)}% APY over ${(years * 525960).toFixed(0)} min (implied ${(impliedApy * 100).toFixed(2)}% APY)`);
    else line(`   · interest-accrual — too early to measure (theoretical ${theo.toFixed(6)})`); }

  // ── rate-limit window, LIVE (staging window = 300 s) ──────────────────────────────────────
  // Runs BEFORE this tick's config upgrade (an upgrade resets both windows). Pins the mechanics of
  // FixedIncomeVaultWithdrawing_v1._calculateQuantityAvailableToWithdrawInLimitWindow:
  //   fresh window: available = vaultPct×totalOwed + depositorPct×owed (additive)
  //   a withdrawal consumes budget at ENQUEUE and stamps windowEnd = t0 + size
  //   next window: depositor cap = max(previous cap (+interest), pct×owed) → CARRIED, not re-based
  {
    const dep = new ethers.Wallet(st.depPk, p); await topUpGas(dep.address);
    const WINDOW_S = Number(await c.withdrawalLimitWindowSizeInS());
    try {
      const s0 = await sum(); const total0 = await vaultTotal();
      const fresh0 = 0.1 * total0 + 0.1 * s0.owed;
      check("rate-limit-fresh-window", Math.abs(s0.avail - fresh0) < 0.05, `available ${s0.avail.toFixed(2)} = 10%×vault ${total0.toFixed(2)} + 10%×depositor ${s0.owed.toFixed(2)} (additive, window ${WINDOW_S}s)`);
      const d2before = dep2Addr ? await sumFor(dep2Addr) : undefined;
      if (d2before) check("rate-limit-fresh-window-dep2", Math.abs(d2before.avail - (0.1 * total0 + 0.1 * d2before.owed)) < 0.05, `depositor 2 available ${d2before.avail.toFixed(2)} = 10%×vault ${total0.toFixed(2)} + 10%×own ${d2before.owed.toFixed(2)}`);
      const rc = await waitRc(await withdrawOnChain(p, dep, st.manager, 5));
      const t0 = Number((await p.getBlock(rc.blockNumber))!.timestamp);
      const s1 = await sum();
      check("rate-limit-budget-consumed", Math.abs(s1.avail - (s0.avail - 5)) < 0.05 && s1.windowEnd === t0 + WINDOW_S, `available ${s0.avail.toFixed(2)}→${s1.avail.toFixed(2)} right after enqueue (locked ${s1.locked.toFixed(2)}); windowEnd = t0+${s1.windowEnd - t0}s`);
      // the VAULT part of the budget is shared: depositor 1's $5 came out of it, so depositor 2 loses $5 of headroom without withdrawing anything
      if (d2before) { const d2after = await sumFor(dep2Addr!); check("vault-budget-shared", Math.abs(d2after.avail - (d2before.avail - 5)) < 0.05, `depositor 2 available ${d2before.avail.toFixed(2)}→${d2after.avail.toFixed(2)} after depositor 1 withdrew $5 (shared vault budget)`); }
      let s2 = s1;
      for (let i = 0; i < 20 && s2.owed > s0.owed - 4.5; i++) { await sleep(6000); s2 = await sum(); }
      check("dispatcher-withdrawal", s2.owed <= s0.owed - 4.5, s2.owed <= s0.owed - 4.5 ? `owed ${s0.owed.toFixed(2)}→${s2.owed.toFixed(2)} (staging dispatcher applied the $5 local withdrawal)` : `enqueued but not applied in 120s (owed ${s0.owed.toFixed(2)}→${s2.owed.toFixed(2)}); dispatcher may be lagging`);
      const waitMs = (s1.windowEnd + 2) * 1000 - Date.now();
      if (waitMs > 0) { line(`   … waiting ${Math.ceil(waitMs / 1000)}s for the ${WINDOW_S}s window to elapse`); await sleep(waitMs); }
      let bt = Number((await p.getBlock("latest"))!.timestamp);
      while (bt <= s1.windowEnd) { await sleep(2000); bt = Number((await p.getBlock("latest"))!.timestamp); }
      const s3 = await sum(); const total3 = await vaultTotal();
      const carried = 0.1 * total3 + 0.1 * s0.owed;   // vault part re-based to the current total; depositor cap carried from window 1
      const rebased = 0.1 * total3 + 0.1 * s3.owed;   // what "% of what is left" would give
      check("rate-limit-cap-carried", Math.abs(s3.avail - carried) < 0.05 && s3.avail > rebased + 0.3, `new window: available ${s3.avail.toFixed(2)} ≈ 10%×vault ${total3.toFixed(2)} + CARRIED 10%×${s0.owed.toFixed(2)} (re-basing to remaining owed would give ${rebased.toFixed(2)})`);
      st.withdrawTested = true; saveState(st);
    } catch (e: any) { check("rate-limit-window-live", false, `threw: ${String(e?.shortMessage ?? e?.reason ?? e?.message ?? e).slice(0,110)}`); }
  }

  // config-upgrade delay 0 — and it RESETS the limit windows (carried cap discarded → fresh pct×owed)
  const before = Number(await c.loadVaultConfigurationsLength(st.manager));
  const f = { ...FIELDS, maximumNetDepositsInPips: FIELDS.maximumNetDepositsInPips + pip(1) };
  await waitRc((await c.initiateManagedAccountUpgrade(encodeCfg(st.manager, f), { gasLimit: 800_000 })).hash);
  await waitRc((await c.finalizeManagedAccountUpgrade({ gasLimit: 800_000 })).hash);
  const after = Number(await c.loadVaultConfigurationsLength(st.manager));
  check("config-upgrade-delay0", after === before + 1, `config history ${before}→${after} (same-tick finalize, upgradeDelay=0)`);
  { const su = await sum(); const tu = await vaultTotal(); const fresh = 0.1 * tu + 0.1 * su.owed;
    check("upgrade-resets-window", Math.abs(su.avail - fresh) < 0.05, `after upgrade available ${su.avail.toFixed(2)} = fresh 10%×${tu.toFixed(2)} + 10%×${su.owed.toFixed(2)} (window restarted, carried cap discarded)`); }

  // downgrade-bypass live
  const avail = async () => (await sum()).avail;
  const owed  = async () => (await sum()).owed;
  const base = await avail(), ow = await owed();
  await waitRc((await c.initiateManagedAccountUpgrade(encodeCfg(st.manager, { ...FIELDS, interestMultiplierInPips: 0n }), { gasLimit: 800_000 })).hash);
  const bypassed = await avail();
  await waitRc((await c.cancelManagedAccountUpgrade({ gasLimit: 400_000 })).hash);
  const restored = await avail();
  const bound = base < ow - 0.5;
  check("downgrade-bypass-live", bypassed >= ow - 0.01 && (!bound || restored <= base + 0.01), `cap ${bound?"BINDS":"slack"}: base=${base.toFixed(2)} in-flight=${bypassed.toFixed(2)} owed=${ow.toFixed(2)} restored=${restored.toFixed(2)}`);
}

async function finalize(st: any) {
  const mgr = new ethers.Wallet(st.mgrPk, p), dep = new ethers.Wallet(st.depPk, p);
  const deps: { w: InstanceType<typeof ethers.Wallet>; who: string }[] = [{ w: dep, who: "depositor" }];
  if (st.dep2Pk) deps.push({ w: new ethers.Wallet(st.dep2Pk, p), who: "depositor2" });
  const balRead = new ethers.Contract(PROVIDER, UP_ABI, p) as any;
  const ex = new ethers.Contract(EXCHANGE, EX_ABI, p) as any;
  const cppS = Number(await ex.chainPropagationPeriodInS());
  const vpMgr = new ethers.Contract(PROVIDER, EXIT_ABI, mgr) as any;
  let eavPre = st.eavPre;
  if (st.phase !== "exited") {
    eavPre = Number(await ex.loadQuoteQuantityAvailableForExitWithdrawal(st.manager)) / 1e8;
    // owed per depositor at exit time → each should receive exactly this when the vault is solvent
    st.owedPre = {};
    for (const d of deps) st.owedPre[d.w.address] = Number((await balRead.loadVaultBalanceForWalletSummary(st.manager, d.w.address))[3]) / 1e8;
    line(`\n[${now()}] ── FINALIZE window: exit ${st.manager}  EAV_pre $${eavPre.toFixed(4)}  owed ${deps.map(d => "$" + st.owedPre[d.w.address].toFixed(4)).join(" + ")}  CPP ${cppS}s ──`);
    await topUpGas(mgr.address);
    try { await vpMgr.exitWallet.staticCall(st.manager); } catch (e: any) { line(`   ✗ exitWallet staticCall reverted: ${e?.shortMessage ?? e?.reason ?? e?.message}`); return; }
    await waitRc((await vpMgr.exitWallet(st.manager, { gasLimit: 1_500_000 })).hash);
    const s1 = await vpMgr.loadVaultSummary(st.manager);
    if (!s1[1]) { line("   ✗ not exited after exitWallet"); return; }
    line(`   ✓ exitWallet mined — isExited=true`);
    st.phase = "exited"; st.eavPre = eavPre; saveState(st);
    line(`   waiting CPP ${cppS + CPP_MARGIN_S}s…`); await sleep((cppS + CPP_MARGIN_S) * 1000);
  } else { line(`\n[${now()}] ── RESUME finalize: ${st.manager} exited; finishing withdrawExit ──`); }
  for (const d of deps) await topUpGas(d.w.address);
  await topUpGas(mgr.address);
  const before = new Map<string, bigint>();
  for (const d of deps) before.set(d.w.address, await usdcRead.balanceOf(d.w.address));
  const mgrB = await usdcRead.balanceOf(mgr.address);
  const calls: [any, string, string][] = deps.map(d => [new ethers.Contract(PROVIDER, EXIT_ABI, d.w) as any, d.w.address, d.who] as [any, string, string]);
  calls.push([vpMgr, mgr.address, "manager"]);
  for (const [c, d, who] of calls) {
    try { await c.withdrawExit.staticCall(st.manager, d); } catch (e: any) { line(`   ✗ withdrawExit(${who}) staticCall: ${e?.shortMessage ?? e?.reason ?? e?.message}`); continue; }
    await waitRc((await c.withdrawExit(st.manager, d, { gasLimit: 2_500_000 })).hash); line(`   ✓ withdrawExit ${who} mined`);
  }
  let depGot = 0; const parts: string[] = []; let payoutOk = true;
  for (const d of deps) {
    const got = Number(await usdcRead.balanceOf(d.w.address) - before.get(d.w.address)!) / 1e6; depGot += got;
    const owed = st.owedPre?.[d.w.address];
    if (owed !== undefined) { const ok = Math.abs(got - owed) < 0.02; payoutOk &&= ok; parts.push(`${d.who} $${got.toFixed(4)}${ok ? "=" : "≠"}owed $${owed.toFixed(4)}`); }
    else parts.push(`${d.who} $${got.toFixed(4)}`);
  }
  const mgrGot = Number(await usdcRead.balanceOf(mgr.address) - mgrB) / 1e6;
  const recovered = depGot + mgrGot, conserved = Math.abs(recovered - eavPre) < 1.5;
  line(`   RECOVERED ${parts.join(" + ")} + mgr $${mgrGot.toFixed(4)} = $${recovered.toFixed(4)} vs EAV_pre $${eavPre.toFixed(4)}`);
  if (st.owedPre && deps.length > 1) {
    const sumOwed = Object.values(st.owedPre as Record<string, number>).reduce((a, b) => a + b, 0);
    check("multi-depositor-exit-payout", payoutOk && Math.abs(mgrGot - (eavPre - sumOwed)) < 0.02, `solvent exit: each depositor paid its full owed, manager got the residual $${mgrGot.toFixed(4)} = EAV_pre − Σowed $${(eavPre - sumOwed).toFixed(4)}`);
  }
  check("exit-conservation", conserved, `Δ$${(recovered - eavPre).toFixed(4)}`);
  for (const d of deps) await sweepAll(d.w.privateKey, d.who);
  await sweepAll(mgr.privateKey, "manager");
  st.phase = "done"; saveState(st);
}

async function mint(prev: any) {
  const window = (prev?.window ?? 0) + 1;
  const mw = ethers.Wallet.createRandom(), dw = ethers.Wallet.createRandom(), dw2 = ethers.Wallet.createRandom();
  const st: any = { window, manager: mw.address, mgrPk: mw.privateKey, depPk: dw.privateKey, dep2Pk: dw2.privateKey, createdAt: Date.now(), lastMintAt: Date.now(), phase: "minting", withdrawTested: false };
  saveState(st);
  line(`\n[${now()}] ── window #${window}: minting exit-eligible vault ${mw.address} (seed $${SEED}, deps $${DEP} + $${DEP2}, exitMult 2.0, caps 10/10) ──`);
  await ensureFunded(p, mw.address, process.env.MGR_ETH!, String(SEED + 25));
  const live = await createVault(p, { manager: new ethers.Wallet(mw.privateKey, p), seedUsd: SEED, fields: FIELDS, log: line });
  if (!live) throw new Error("vault did not go live (ComposeFailed; seed recoverable)");
  line("   ✓ vault LIVE");
  await ensureFunded(p, dw.address, process.env.DEP_ETH!, String(DEP + 5));
  const ok = await depositTo(p, { managerAddr: mw.address, dep: new ethers.Wallet(dw.privateKey, p), amountUsd: DEP, expectDepositors: 1, settleMs: 8000, log: line });
  line(`   depositor 1 $${DEP}: ${ok ? "applied" : "NOT applied"}`);
  await ensureFunded(p, dw2.address, process.env.DEP_ETH!, String(DEP2 + 5));
  const ok2 = await depositTo(p, { managerAddr: mw.address, dep: new ethers.Wallet(dw2.privateKey, p), amountUsd: DEP2, expectDepositors: 2, settleMs: 8000, log: line });
  line(`   depositor 2 $${DEP2}: ${ok2 ? "applied" : "NOT applied"}`);
  st.phase = "live"; saveState(st);
  if (prev && prev.mgrPk && prev.phase !== "done") { await sweepAll(prev.mgrPk, `stale mgr #${prev.window}`); await sweepAll(prev.depPk, `stale dep #${prev.window}`); if (prev.dep2Pk) await sweepAll(prev.dep2Pk, `stale dep2 #${prev.window}`); }
  return st;
}

// ── main ──
mkdirSync(dirname(LOG), { recursive: true });
line(`\n════════ staging-lab ${now()} ════════`);
const fbal = await p.getBalance(FUNDING.address);
line(`funding ${FUNDING.address} ETH ${ethers.formatEther(fbal)}`);
const st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
const provRead = new ethers.Contract(PROVIDER, UP_ABI, p) as any;

async function vaultLive(mgr: string) { try { const s = await provRead.loadVaultSummary(mgr); return { active: s[0], exited: s[1], liq: s[2] }; } catch { return null; } }

try {
  if (st && st.phase === "exited") { await finalize(st); }
  else if (st && st.phase === "live") {
    const v = await vaultLive(st.manager);
    if (!v || v.liq || (!v.active && !v.exited)) { line(`vault #${st.window} not usable (${JSON.stringify(v)}) — minting`); if (fbal < MIN_MINT_ETH) { line(`⛔ funding ETH ${ethers.formatEther(fbal)} < ${ethers.formatEther(MIN_MINT_ETH)} — not minting`); process.exit(1);} await mint(st); }
    else {
      const ageMin = (Date.now() - st.createdAt) / 60000;
      if (process.env.FINALIZE === "1" || ageMin >= WINDOW_MIN) { await finalize(st); }
      else { line(`\n[${now()}] reusing vault #${st.window} ${st.manager} (age ${ageMin.toFixed(0)}m, window ${WINDOW_MIN}m)`); await battery(st); }
    }
  } else {
    const sinceMint = st ? (Date.now() - (st.lastMintAt ?? 0)) / 60000 : 1e9;
    if (sinceMint < RATE_MIN) { line(`rate-limited: ${sinceMint.toFixed(0)}min since last mint (<${RATE_MIN}). Holding.`); process.exit(0); }
    if (fbal < MIN_MINT_ETH) { line(`⛔ funding ETH ${ethers.formatEther(fbal)} < ${ethers.formatEther(MIN_MINT_ETH)} — too low to mint. Stopping.`); process.exit(1); }
    const s2 = await mint(st); await battery(s2);
  }
} catch (e: any) { line(`⛔ tick threw: ${String(e?.shortMessage ?? e?.reason ?? e?.message ?? e).slice(0,160)}`); process.exit(1); }

const pass = results.filter(r => r.pass).length;
line(`\nRESULT: ${pass}/${results.length} passed — funding ETH ${ethers.formatEther(await p.getBalance(FUNDING.address))}`);
