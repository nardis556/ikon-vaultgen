/**
 * associate.ts — MODE=associate: register every wallet with the exchange and attach API credentials.
 *
 * A brand-new wallet must be associated before the exchange will surface a balance for it, so an
 * on-chain deposit made before association reads as "not credited". Run this once per deployment,
 * after the wallets exist and before provisioning.
 *
 * An API key identifies an ACCOUNT, not a wallet: any number of wallets associate into one account
 * and each keeps its own balances and positions. So MANAGER_API_KEY covers the manager and
 * DEPOSITOR_API_KEY covers the whole pool — no need for a key per wallet.
 *
 * Credentials are needed for:
 *   - the manager: setVaultDetails (name/description) and market-making orders
 *   - depositors:  withdrawals only (deposits are pure on-chain approve+deposit)
 */
import * as kperps from "@katanaperps/katana-perps-sdk";
import { v1 as uuidv1 } from "uuid";
import { config } from "./config.js";
import { loadStrategy } from "./strategy.js";
import { loadManager, loadDepositorPool, writeCredentials, type Signer } from "./wallets.js";

const log = (m = "") => console.log(m);

function client(apiKey: string, apiSecret: string, pk: string) {
  return new kperps.RestAuthenticatedClient({
    apiKey, apiSecret, walletPrivateKey: pk,
    baseURL: config.baseUrl, chainId: config.chainId, sandbox: config.sandbox,
    exchangeContractAddress: config.exchangeContract,
    // associateWallet builds an EIP-712 payload that needs a bridge adapter address.
    // Zero = local, no bridge.
    bridgeAdapterContractAddress: "0x0000000000000000000000000000000000000000",
  });
}

async function associate(list: Signer[], apiKey: string, apiSecret: string, dry: boolean) {
  let ok = 0, already = 0, failed = 0;
  for (const w of list) {
    if (dry) { log(`    · ${w.name} ${w.address} would associate`); continue; }
    try {
      await client(apiKey, apiSecret, w.privateKey).associateWallet({ nonce: uuidv1(), wallet: w.address });
      log(`    ✓ ${w.name} ${w.address}`);
      ok++;
    } catch (e: any) {
      const code = e?.response?.data?.code ?? "";
      const msg = e?.response?.data?.message ?? e?.message ?? String(e);
      // Re-associating an already-registered wallet is a no-op, not a failure.
      if (/ALREADY|EXISTS|DUPLICATE/i.test(`${code} ${msg}`)) { log(`    = ${w.name} already associated`); already++; }
      else { log(`    ✗ ${w.name}: ${code} ${String(msg).slice(0, 90)}`); failed++; }
    }
  }
  return { ok, already, failed };
}

export async function associateAll() {
  const strategy = loadStrategy(config.strategy);
  const mgrKey = process.env.MANAGER_API_KEY ?? "";
  const mgrSecret = process.env.MANAGER_API_SECRET ?? "";
  const depKey = process.env.DEPOSITOR_API_KEY ?? "";
  const depSecret = process.env.DEPOSITOR_API_SECRET ?? "";

  log("=".repeat(74));
  log(`  ikon-vaultgen associate — ${strategy.display.name} [${strategy.id}] instance ${config.instance}`);
  log("=".repeat(74));
  if (!mgrKey || !mgrSecret) throw new Error("MANAGER_API_KEY / MANAGER_API_SECRET are required");

  const { signer: mgr } = loadManager(false);
  const poolSize = config.depositorPoolSize || strategy.depositors.count;
  const { pool } = loadDepositorPool(poolSize, false);
  log(`  manager      : ${mgr.address}   (key ...${mgrKey.slice(-6)})`);
  log(`  pool         : ${pool.length} wallets`
    + (depKey ? `   (key ...${depKey.slice(-6)})` : `   — no DEPOSITOR_API_KEY, they will deposit only`));
  const dry = !config.execute;
  if (dry) log(`  mode         : DRY-RUN — nothing will be sent`);

  log(`\n  ── manager ──────────────────────────────────────`);
  const m = await associate([mgr], mgrKey, mgrSecret, dry);

  let d = { ok: 0, already: 0, failed: 0 };
  if (depKey && depSecret) {
    log(`\n  ── depositor pool ───────────────────────────────`);
    d = await associate(pool, depKey, depSecret, dry);
  }

  if (!dry) {
    const n1 = writeCredentials("manager", mgrKey, mgrSecret);
    log(`\n  ✓ credentials written into .env.MANAGER (${n1} entry)`);
    if (depKey && depSecret) {
      const n2 = writeCredentials("depositors", depKey, depSecret);
      log(`  ✓ credentials written into .env.DEPOSITORS (${n2} entries)`);
    }
    log(`\n  manager: ${m.ok} associated, ${m.already} already, ${m.failed} failed`);
    if (depKey) log(`  pool   : ${d.ok} associated, ${d.already} already, ${d.failed} failed`);
    log(`\n  next: MODE=fund, then MODE=provision`);
  } else {
    log(`\n  DRY-RUN — set EXECUTE=1 to associate and write credentials. Nothing sent.`);
  }
}
