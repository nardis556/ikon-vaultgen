// Count (and with EXECUTE=1 cancel) every open order of ONE strategy's vault manager.
// Runs INSIDE that strategy's compose container (see cancel-manager-orders.sh), so it uses vaultgen's own loaders:
// the manager key from the mounted .env.MANAGER and the API credentials from the env files the compose loads.
// Prints counts and the manager address only — never keys.
import { config } from "./config.js";
import { loadManager } from "./wallets.js";
import { buildClient } from "./client.js";

const execute = process.env.EXECUTE === "1";
const { signer } = loadManager(false);
const c = buildClient(signer.apiKey || (config as any).managerApiKey, signer.apiSecret || (config as any).managerApiSecret, signer.privateKey);
const open = async () => ((await (c.auth as any).getOrders({ nonce: c.nonce(), wallet: c.wallet, limit: 1000 })) as any[]).length;

const before = await open();
if (!execute) {
  console.log(`${config.strategy} manager ${c.wallet}: ${before} open order(s) — dry run, nothing cancelled (EXECUTE=1 to cancel)`);
} else {
  if (before) await (c.auth as any).cancelOrders({ nonce: c.nonce(), wallet: c.wallet });
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`${config.strategy} manager ${c.wallet}: open orders ${before} → ${await open()}`);
}
