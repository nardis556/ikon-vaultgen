/**
 * fund.ts — MODE=fund: pre-fund a strategy's manager and its whole depositor pool in one pass.
 *
 * Provisioning already tops wallets up just-in-time, so this is not required. It exists so a
 * deterministic pool (POOL_MNEMONIC) can be funded ONCE and then simply be "addresses that are
 * already funded" for every later run and demo — no per-deposit funding transaction in the middle
 * of a live demo, and stable addresses somebody can look up.
 *
 * Idempotent: ensureFunded only sends when a wallet is below target.
 */
import { ethers } from "ethers";
import { config } from "./config.js";
import { loadStrategy } from "./strategy.js";
import { loadManager, loadDepositorPool, isDeterministic } from "./wallets.js";
import { provider, ensureFunded, USDC_DECIMALS , rpcRetry } from "./vault.js";

const log = (m = "") => console.log(m);

export async function fund() {
  const strategy = loadStrategy(config.strategy);
  const { signer: mgr } = loadManager(config.generateWallets);
  const poolSize = config.depositorPoolSize || strategy.depositors.count;
  const { pool } = loadDepositorPool(poolSize, config.generateWallets);

  // Enough for the initial deposit plus several churn top-ups, so the pool does not need
  // re-funding mid-demo.
  const perDep = Number(config.fundDepUsd || 0)
    || Math.ceil(strategy.depositors.amountUsdRange[1] * 1.8 + 5);
  const mgrUsd = strategy.seed.managerSeedUsd + 25;

  log("=".repeat(74));
  log(`  ikon-vaultgen fund — ${strategy.display.name} [${strategy.id}] instance ${config.instance}`);
  log("=".repeat(74));
  log(`  wallets      : ${isDeterministic() ? "DETERMINISTIC (POOL_MNEMONIC)" : "random — set POOL_MNEMONIC for stable addresses"}`);
  log(`  manager      : ${mgr.address}  → $${mgrUsd} + ${config.mgrEth} ETH`);
  log(`  pool         : ${pool.length} wallets → $${perDep} + ${config.depEth} ETH each`);

  const p = provider();
  const funding = new ethers.Wallet(config.fundingKey, p);
  const vb = new ethers.Contract(config.quoteToken, ["function balanceOf(address) view returns (uint256)"], p) as any;
  const haveUsd = Number(ethers.formatUnits(await rpcRetry("funding balanceOf", () => vb.balanceOf(funding.address)), USDC_DECIMALS));
  const haveEth = Number(ethers.formatEther(await rpcRetry("funding getBalance", () => p.getBalance(funding.address))));
  const needUsd = mgrUsd + perDep * pool.length;
  const needEth = Number(config.mgrEth) + Number(config.depEth) * pool.length;
  log(`\n  funding      : ${funding.address}`);
  log(`  have         : ${haveEth.toFixed(6)} ETH  $${haveUsd.toFixed(2)} vbUSDC`);
  log(`  need (worst) : ${needEth.toFixed(6)} ETH  $${needUsd.toFixed(2)} vbUSDC`);
  if (haveUsd < needUsd) throw new Error(`funding wallet short $${(needUsd - haveUsd).toFixed(2)} vbUSDC`);
  if (haveEth < needEth) throw new Error(`funding wallet short ${(needEth - haveEth).toFixed(6)} ETH`);

  if (!config.execute) { log(`\n  DRY-RUN — set EXECUTE=1 to fund. Nothing sent.`); return; }

  log(`\n  ── funding ──────────────────────────────────────`);
  await ensureFunded(p, mgr.address, config.mgrEth, String(mgrUsd));
  log(`  ✓ manager ${mgr.address}`);
  let n = 0;
  for (const w of pool) {
    await ensureFunded(p, w.address, config.depEth, String(perDep));
    log(`  ✓ ${w.name} ${w.address}`);
    n++;
  }
  log(`\n  funded ${n} pool wallets + manager. These addresses are now pre-funded and stable.`);
}
