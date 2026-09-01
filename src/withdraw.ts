/**
 * withdraw.ts — depositor withdrawals from a vault.
 *
 * NOTE ON THE SDK: setVaultDetails and withdrawFromManagedAccountByQuantity are NOT plain methods
 * on the authenticated client. They live under an internal namespace keyed by
 * `Symbol.for('@katanaPerps/internal')` (exported as INTERNAL_SYMBOL). Calling
 * `client.auth.setVaultDetails(...)` silently yields undefined — it has to go through the symbol.
 *
 * Withdrawals are ENQUEUED, then applied by the managed-account withdrawal dispatcher. So a
 * successful call means "accepted into the queue", not "funds moved"; confirmation is a vault-state
 * read afterwards. Two limits bound how much can leave:
 *   - withdrawalLimitPctDepositors — per depositor per window
 *   - withdrawalLimitPctVault      — across the whole vault per window
 * `quantityAvailableToWithdraw` on the per-wallet summary already accounts for both, so it is the
 * authoritative cap; do not compute it from owed.
 */
import * as kperps from "@katanaperps/katana-perps-sdk";
import type { Client } from "./client.js";
import { config } from "./config.js";

const INTERNAL = (kperps as any).INTERNAL_SYMBOL ?? Symbol.for("@katanaPerps/internal");

/** The internal namespace, or a clear error naming what is missing. */
export function internalApi(client: Client): any {
  const api = (client.auth as any)[INTERNAL];
  if (!api) throw new Error("SDK internal namespace unavailable — the installed "
    + "@katanaperps/katana-perps-sdk does not expose Symbol.for('@katanaPerps/internal'). "
    + "setVaultDetails and vault withdrawals both require it.");
  return api;
}

export async function setVaultDetails(client: Client, name: string, description: string) {
  return internalApi(client).setVaultDetails({
    nonce: client.nonce(), wallet: client.wallet, name, description,
  });
}

/** Live gas fee for the withdrawal, so maximumGasFee is not a guess. */
async function withdrawalGasFee(client: Client): Promise<string> {
  try {
    const fees: any = await (client.public as any).getGasFees();
    const f = fees?.withdrawalFromManagedAccount ?? fees?.withdrawal ?? fees?.withdraw;
    if (f) return String(f);
  } catch {}
  return "0.10";
}

/**
 * Enqueue a withdrawal of `quantityUsd` for this depositor.
 * Returns the SDK response, or throws with the API's reason.
 */
export async function withdrawByQuantity(
  client: Client, managerWallet: string, quantityUsd: number,
) {
  const bridgeTarget = (kperps as any).BridgeTarget?.KATANA_KATANA ?? "katana.katana";
  const maximumGasFee = await withdrawalGasFee(client, bridgeTarget);
  return internalApi(client).withdrawFromManagedAccountByQuantity({
    nonce: client.nonce(),
    wallet: client.wallet,
    managerWallet,
    // 8dp, like every other decimal this API takes.
    quantity: quantityUsd.toFixed(8),
    // Shares are burned to produce the quantity; an explicit generous cap avoids a
    // rounding-driven rejection while still bounding the trade.
    maxShares: (quantityUsd * 10).toFixed(8),
    maximumGasFee,
    managedAccountProvider: config.vaultProvider,
    // Required (not optional) — omitting it sends null and ethers rejects it as an
    // "invalid BytesLike value" long before the request is signed. No provider-specific
    // data is needed for a plain quantity withdrawal, so empty bytes.
    managedAccountProviderPayload: "0x",
    bridgeTarget,
  });
}
