/**
 * provision.ts — one-shot: create one strategy's vault, name it, and seed its initial depositors.
 *
 * Re-running with the same INSTANCE resumes the SAME vault, because wallet material persists.
 * Bump INSTANCE to deliberately create a second vault of the same strategy.
 *
 * DRY-RUN unless EXECUTE=1. The dry run performs every read and every check — protocol drift,
 * strategy validation, funding budget — and prints the exact plan without sending a transaction.
 */
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { ethers } from "ethers";
import { decimalToPip } from "@katanaperps/katana-perps-sdk";
import { config } from "./config.js";
import { loadStrategy, validateStrategy, toChainFields,
         EXPECTED_CREATION_FEE, EXPECTED_CREATION_MINIMUM, EXPECTED_DEPOSIT_FEE } from "./strategy.js";
import { loadManager, loadDepositorPool } from "./wallets.js";
import { provider, ensureFunded, createVault, depositTo, readVault, existingVault, USDC_DECIMALS } from "./vault.js";
import { buildClient } from "./client.js";
import { setVaultDetails } from "./withdraw.js";

const log = (m = "") => console.log(m);

/** Deterministic per-strategy amounts so a re-run and any demo script agree. */
function seededAmounts(id: string, count: number, [lo, hi]: [number, number]): number[] {
  let h = 2166136261;
  for (const c of id) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    h = Math.imul(h ^ (i + 1), 16777619); h >>>= 0;
    out.push(Math.round(lo + (h / 0xffffffff) * (hi - lo)));
  }
  return out;
}

export async function provision() {
  const strategy = loadStrategy(config.strategy);
  const warns = validateStrategy(strategy);

  log("=".repeat(74));
  log(`  ikon-vaultgen — ${strategy.display.name}  [${strategy.id}]  instance ${config.instance}`);
  log("=".repeat(74));
  log(`  profile      : ${strategy.profile}`);
  log(`  interest     : ${strategy.vault.interestApyPct}% APY`);
  log(`  exit thresh  : ${strategy.vault.exitMultiplier}x owed     mgr-withdraw: ${strategy.vault.managerWithdrawMultiplier}x owed`);
  log(`  queue age    : ${strategy.vault.unappliedAgeS}s     maxNetDeposits: $${strategy.vault.maximumNetDeposits}`);
  log(`  wd limits    : depositor ${strategy.vault.withdrawalLimitPctDepositors}%  vault ${strategy.vault.withdrawalLimitPctVault}%`);
  log(`  churn        : ${strategy.churn.enabled ? `every ${strategy.churn.intervalHoursRange.join("-")}h per wallet` : "off"}`);
  log(`  market making: ${strategy.marketMaking.enabled
      ? `${strategy.marketMaking.markets.join(", ")} skew=${strategy.marketMaking.skewStrength}` : "off"}`);
  for (const w of warns) log(`  ⚠ ${w}`);
  log();

  // ── Protocol drift check ─────────────────────────────────────────────────────────────────
  const res = await fetch(`${config.baseUrl}/exchange`, { headers: { "User-Agent": "ikon-vaultgen" } });
  if (!res.ok) throw new Error(`GET /exchange failed: HTTP ${res.status}`);
  const ex: any = await res.json();
  const v = ex.vaults ?? {};
  log(`  exchange     : ${ex.exchangeContractAddress}  chainId ${ex.chainId}`);
  log(`  provider     : ${v.fixedIncomeVaultProviderV1ContractAddress}`);
  log(`  fees         : creationMin $${v.vaultCreationMinimum}  creationFee $${v.vaultCreationFee}  depositFee $${v.vaultDepositFee}`);

  if (v.fixedIncomeVaultProviderV1ContractAddress?.toLowerCase() !== config.vaultProvider.toLowerCase()) {
    throw new Error(`VAULT_PROVIDER mismatch — env says ${config.vaultProvider}, the API serves `
      + `${v.fixedIncomeVaultProviderV1ContractAddress}. Creating vaults on a provider the backend does not `
      + `service means deposits enqueue and never apply. Refusing.`);
  }
  if (ex.exchangeContractAddress?.toLowerCase() !== config.exchangeContract.toLowerCase()) {
    throw new Error(`EXCHANGE_CONTRACT mismatch — env ${config.exchangeContract}, API ${ex.exchangeContractAddress}. Refusing.`);
  }
  const creationFloor = Number(v.vaultCreationMinimum) + Number(v.vaultCreationFee);
  if (Number(v.vaultCreationMinimum) !== EXPECTED_CREATION_MINIMUM
      || Number(v.vaultCreationFee) !== EXPECTED_CREATION_FEE
      || Number(v.vaultDepositFee) !== EXPECTED_DEPOSIT_FEE) {
    log(`  ⚠ live fees differ from the strategy assumptions — effective seed floor is now $${creationFloor}`);
  }
  if (strategy.seed.managerSeedUsd < creationFloor)
    throw new Error(`seed $${strategy.seed.managerSeedUsd} is below the LIVE floor $${creationFloor}. Refusing.`);

  // ── Wallets ──────────────────────────────────────────────────────────────────────────────
  const { signer: mgr, created: mgrCreated } = loadManager(config.generateWallets);
  const poolSize = config.depositorPoolSize || strategy.depositors.count;
  const { pool, created: poolCreated } = loadDepositorPool(poolSize, config.generateWallets);
  const initial = pool.slice(0, strategy.depositors.count);
  log(`\n  manager      : ${mgr.address}${mgrCreated ? "  (newly generated)" : ""}`
    + `${mgr.apiKey ? "  [api creds present]" : "  [no api creds — setVaultDetails/MM unavailable]"}`);
  log(`  pool         : ${pool.length} wallets${poolCreated ? ` (${poolCreated} newly generated)` : ""}`
    + `, seeding the first ${initial.length}`);
  if (pool.length > initial.length)
    log(`                 ${pool.length - initial.length} held back — the churn daemon brings them in over time`);

  const amounts = seededAmounts(strategy.id, initial.length, strategy.depositors.amountUsdRange);
  const depTotal = amounts.reduce((a, b) => a + b, 0);
  const netOwed = depTotal - amounts.length * EXPECTED_DEPOSIT_FEE;
  log(`  deposits     : [${amounts.join(", ")}]  total $${depTotal} → owed ≈ $${netOwed.toFixed(2)} after fees`);

  // ── Does this vault already exist? ───────────────────────────────────────────────────────
  const p0 = provider();
  const prior = await existingVault(p0, mgr.address);
  if (prior.exists) {
    log(`\n  EXISTING VAULT at ${mgr.address}`);
    log(`    active=${prior.isActive} exited=${prior.isExited} liquidated=${prior.isLiquidated}`);
    log(`    depositors=${prior.numDepositorWallets}  netDeposits=$${prior.depositorNetDeposits.toFixed(2)}  owed=$${prior.totalOwed.toFixed(2)}`);
    if (prior.isLiquidated || prior.isExited) {
      throw new Error(`vault at ${mgr.address} is ${prior.isLiquidated ? "liquidated" : "exited"} and cannot be `
        + `reused. Bump INSTANCE (and clear .env.MANAGER) to provision a fresh one.`);
    }
    log(`    → skipping creation; will top up depositors to the target set instead`);
  }

  // ── Budget ───────────────────────────────────────────────────────────────────────────────
  const p = provider();
  const funding = new ethers.Wallet(config.fundingKey, p);
  const vb = new ethers.Contract(config.quoteToken, ["function balanceOf(address) view returns (uint256)"], p) as any;
  const haveEth = Number(ethers.formatEther(await p.getBalance(funding.address)));
  const haveUsd = Number(ethers.formatUnits(await vb.balanceOf(funding.address), USDC_DECIMALS));
  const needUsd = strategy.seed.managerSeedUsd + 10 + depTotal + amounts.length * 5;
  const needEth = Number(config.mgrEth) + initial.length * Number(config.depEth);
  log(`\n  funding      : ${funding.address}`);
  log(`  have         : ${haveEth.toFixed(6)} ETH   $${haveUsd.toFixed(2)} vbUSDC`);
  log(`  need         : ${needEth.toFixed(6)} ETH   $${needUsd.toFixed(2)} vbUSDC`);
  if (haveUsd < needUsd) throw new Error(`funding wallet short $${(needUsd - haveUsd).toFixed(2)} vbUSDC — top up ${funding.address}`);
  if (haveEth < needEth) throw new Error(`funding wallet short ${(needEth - haveEth).toFixed(6)} ETH — top up ${funding.address}`);

  if (!config.execute) { log(`\n  DRY-RUN — every check passed. Set EXECUTE=1 to provision. Nothing sent.`); return; }

  // ── Create ───────────────────────────────────────────────────────────────────────────────
  const managerWallet = new ethers.Wallet(mgr.privateKey, p);
  if (prior.exists) {
    log(`\n  ── vault already exists — creation skipped ──────`);
  } else {
    log(`\n  ── creating vault ───────────────────────────────`);
    await ensureFunded(p, managerWallet.address, config.mgrEth, String(strategy.seed.managerSeedUsd + 25));
    const live = await createVault(p, {
      manager: managerWallet, seedUsd: strategy.seed.managerSeedUsd,
      fields: toChainFields(strategy, decimalToPip as any), log,
    });
    if (!live) throw new Error(`vault did not go live — look for a ComposeFailed event; the seed will be in `
      + `${managerWallet.address}'s exchange balance, recoverable.`);
    log(`  ✓ vault LIVE at manager ${managerWallet.address}`);
  }

  // ── Name + description ───────────────────────────────────────────────────────────────────
  if (config.setDetails && mgr.apiKey && mgr.apiSecret) {
    try {
      await setVaultDetails(buildClient(mgr.apiKey, mgr.apiSecret, mgr.privateKey),
        strategy.display.name, strategy.display.description);
      log(`  ✓ details set: "${strategy.display.name}" (${strategy.display.description.length} char description)`);
    } catch (e: any) {
      log(`  ! setVaultDetails failed: ${String(e?.message ?? e).slice(0, 140)}`);
      log(`    vault is live regardless — rerun with credentials to set details later`);
    }
  } else log(`  – skipping setVaultDetails (no manager API credentials)`);

  // ── Depositors ───────────────────────────────────────────────────────────────────────────
  log(`\n  ── seeding ${initial.length} depositors ─────────────────────`);
  let ok = 0;
  for (let i = 0; i < initial.length; i++) {
    const d = new ethers.Wallet(initial[i].privateKey, p);
    if (prior.exists) {
      // Re-run: only seed wallets that are not already depositors, so a resumed provision
      // tops up the set instead of double-depositing everyone.
      const { vaultBalance } = await import("./vault.js");
      const b = await vaultBalance(p, managerWallet.address, d.address);
      if (b.owed > 0) { log(`  = ${initial[i].name} already a depositor ($${b.owed.toFixed(2)}) — skipping`); ok++; continue; }
    }
    await ensureFunded(p, d.address, config.depEth, String(amounts[i] + 5));
    const credited = await depositTo(p, {
      managerAddr: managerWallet.address, dep: d, amountUsd: amounts[i],
      expectDepositors: i + 1, settleMs: config.settleMs, log,
    });
    log(`  ${credited ? "✓" : "✗"} ${initial[i].name} ${d.address}  $${amounts[i]}`);
    if (credited) ok++;
  }

  // ── Verify ───────────────────────────────────────────────────────────────────────────────
  log(`\n  ── verification (pinned block) ──────────────────`);
  const st = await readVault(p, managerWallet.address, initial.map((d) => d.address));
  log(`  block ${st.pin}  active=${st.isActive} exited=${st.isExited} liquidated=${st.isLiquidated}`);
  log(`  numDepositorWallets : ${st.numDepositorWallets} / ${initial.length}`);
  log(`  depositorPending    : $${st.depositorPending.toFixed(2)}  (must be 0)`);
  log(`  depositorNetDeposits: $${st.depositorNetDeposits.toFixed(2)}   expected $${netOwed.toFixed(2)}`);
  log(`  totalOwed           : $${st.totalOwed.toFixed(8)}  (≥ netDeposits by accrued interest)`);
  log(`  Σ per-depositor − totalOwed : ${st.deltaPips} pips  (expect −(N−1)…0 from truncation)`);
  const conserved = Math.abs(st.depositorNetDeposits - netOwed) < 0.005;
  log(`  conservation        : ${conserved ? "✓ exact" : "✗ MISMATCH"}`);

  mkdirSync(config.outDir, { recursive: true });
  const outFile = resolve(config.outDir, `${strategy.id}-${config.instance}.json`);
  writeFileSync(outFile, JSON.stringify({
    strategy: strategy.id, profile: strategy.profile, instance: config.instance,
    name: strategy.display.name, manager: managerWallet.address,
    provider: config.vaultProvider, exchange: config.exchangeContract,
    seedUsd: strategy.seed.managerSeedUsd,
    depositors: initial.map((d, i) => ({ address: d.address, amountUsd: amounts[i] })),
    poolSize: pool.length, verified: st, conserved, depositorsCredited: ok,
  }, null, 2));
  log(`\n  summary → ${outFile}`);
  log(`  ${ok}/${initial.length} depositors credited`);
  if (strategy.churn.enabled || strategy.marketMaking.enabled)
    log(`  next: MODE=animate to start churn / market making`);
}
