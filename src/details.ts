/**
 * details.ts — MODE=details: set a live vault's name + description, and nothing else.
 *
 * Provision also sets details, but it can only do so once the manager has API credentials — and
 * associate stamps those AFTER provision. Re-running provision to fill them in also re-runs its
 * existence check and depositor top-up, which is the wrong tool for a rename. This mode makes no
 * chain calls at all: it reads the manager from .env.MANAGER and makes one authenticated API call.
 */
import { config } from "./config.js";
import { loadStrategy, vaultDisplayName } from "./strategy.js";
import { loadManager } from "./wallets.js";
import { buildClient } from "./client.js";
import { setVaultDetails } from "./withdraw.js";

export async function details() {
  if (config.freshWallets)
    throw new Error("MODE=details renames a persistent vault — FRESH_WALLETS=1 has no manager to rename.");
  const strategy = loadStrategy(config.strategy);
  const name = vaultDisplayName(strategy, config.vaultNamePrefix);
  const { signer: mgr } = loadManager(false);
  if (!mgr.apiKey || !mgr.apiSecret)
    throw new Error(`manager ${mgr.address} has no API credentials in .env.MANAGER — run MODE=associate first.`);

  console.log(`  ${strategy.id} [${config.instance}]  manager ${mgr.address}`);
  if (!config.execute) {
    console.log(`  DRY-RUN — would set name "${name}" (${strategy.display.description.length} char description)`);
    return;
  }
  await setVaultDetails(buildClient(mgr.apiKey, mgr.apiSecret, mgr.privateKey), name, strategy.display.description);
  console.log(`  ✓ details set: "${name}"`);
}
