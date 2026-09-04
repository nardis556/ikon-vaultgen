/**
 * withdraw-onchain.ts — depositor withdrawals submitted DIRECTLY to the vault provider.
 *
 * The REST route (withdrawFromManagedAccountByQuantity) returns a bare 401 on this deployment,
 * while other internal routes on the same key succeed — so it is gated server-side. That does not
 * matter, because the contract has a deliberate escape hatch:
 *
 *   FixedIncomeVaultWithdrawing_v1.sol:50
 *     "Local withdrawals may be submitted by any wallet to prevent complete censorship of
 *      withdrawals. All other withdrawals may only be sent by the whitelisted withdrawal
 *      dispatcher wallet"
 *
 *   isLocalWithdrawal = bridgeAdapter == address(0) && bridgeAdapterPayload.length == 0
 *
 * So a depositor signs the EIP-712 withdrawal hash and submits it themselves. No dispatcher, no
 * REST, no API credentials at all — which also means churn withdrawals work for every pool wallet,
 * not just ones with keys.
 *
 * Verified live: owed 107.85 -> 105.85 on a $2.00 withdrawal, queue length back to 0.
 *
 * Two things the contract insists on, both of which fail confusingly:
 *   - maximumGasFee must clear MINIMUM_WITHDRAWAL_MAXIMUM_GAS_FEE ($0.05) or it reverts
 *     MaximumGasFeeTooLow(uint64,uint64) — as a bare "unknown custom error" through ethers.
 *   - the signed payload must include bridgeAdapter; omitting it leaves the field undefined and
 *     ethers fails earlier still, with a misleading "network does not support ENS".
 */
import * as kperps from "@katanaperps/katana-perps-sdk";
import { ethers } from "ethers";
import { v1 as uuidv1 } from "uuid";
import { config } from "./config.js";
import { rpcRetry, waitReceipt, PIPS } from "./vault.js";

// CORRECTION (2026-09-04 contract review): a local withdrawal can always be SUBMITTED without the
// dispatcher, but it cannot be APPLIED or CANCELLED without it. applyPendingWithdrawal and
// cancelPendingWithdrawal are both onlyExchange (dispatcher-only). Until it acts the amount is
// locked and stops earning interest. If it never acts, the only recourse is the queue-age exit
// trigger (at least 1h), which exits the ENTIRE vault. Recovery is guaranteed, but via that path.
const ZERO = "0x0000000000000000000000000000000000000000";
/** FixedIncomeVaultProvider_v1.MINIMUM_WITHDRAWAL_MAXIMUM_GAS_FEE = 5_000_000 pips = $0.05 */
export const MINIMUM_MAXIMUM_GAS_FEE = 0.05;

const PROVIDER_ABI = [
  "function withdrawByQuantity((uint128,address,address,uint64,uint64,uint64,address,bytes,address,bytes,uint64,bytes) withdrawal)",
];

const toPips = (n: number) => BigInt(Math.round(n * PIPS));

/**
 * Withdraw `quantityUsd` from `managerWallet`'s vault, signed by and submitted from `depositor`.
 * Returns the tx hash. The withdrawal settles against `owed` — it is not merely queued.
 */
export async function withdrawOnChain(
  p: ethers.JsonRpcProvider,
  depositor: ethers.Wallet,
  managerWallet: string,
  quantityUsd: number,
): Promise<string> {
  const qty = Math.round(quantityUsd * 100) / 100;
  const nonce = uuidv1();
  const maximumGasFee = Math.max(MINIMUM_MAXIMUM_GAS_FEE, 0);

  // Sign the same typed data the contract reconstructs, against the EXCHANGE domain separator.
  const typedData: any = await (kperps as any).getWithdrawalFromManagedAccountByQuantitySignatureTypedData(
    {
      nonce,
      wallet: depositor.address,
      managerWallet,
      quantity: qty.toFixed(8),
      maxShares: (qty * 10).toFixed(8),
      maximumGasFee: maximumGasFee.toFixed(8),
      managedAccountProvider: config.vaultProvider,
      managedAccountProviderPayload: "0x",
      bridgeAdapterAddress: ZERO,
      bridgeAdapterPayload: "0x",
    },
    config.exchangeContract,
    config.chainId,
    config.sandbox,
  );
  const signature = await depositor.signTypedData(typedData[0], typedData[1], typedData[2]);

  const struct = [
    BigInt("0x" + nonce.replace(/-/g, "")),   // uint128 nonce
    managerWallet,
    depositor.address,
    toPips(qty),                              // grossQuantity
    toPips(qty * 10),                         // maxShares
    toPips(maximumGasFee),
    config.vaultProvider,
    "0x",                                     // managedAccountProviderPayload
    ZERO,                                     // bridgeAdapter -> local
    "0x",                                     // bridgeAdapterPayload -> local
    0n,                                       // gasFee actually charged
    signature,
  ];

  const vp = new ethers.Contract(config.vaultProvider, PROVIDER_ABI, depositor) as any;
  // staticCall first: a revert here names the problem, whereas a failed send just burns gas.
  await rpcRetry("withdrawByQuantity staticCall", () => vp.withdrawByQuantity.staticCall(struct));
  // Gas is pinned — this path delegatecalls, and ethers' estimate can trip the 63/64 rule.
  const tx = await rpcRetry("withdrawByQuantity send",
    () => vp.withdrawByQuantity(struct, { gasLimit: 2_000_000 }));
  await waitReceipt(p, tx.hash);
  return tx.hash;
}
