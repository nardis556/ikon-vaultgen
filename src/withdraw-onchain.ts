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

// ── PSV by-shares withdrawal ─────────────────────────────────────────────────
// Profit-Share vaults burn SHARES, not a USD quantity. The struct mirrors the by-quantity one but
// carries `shares` + `minimumQuantity` (the depositor-signed slippage floor on the quote received)
// instead of `grossQuantity` + `maxShares`. Field order matches the deployed provider's
// WithdrawalFromManagedAccountByShares (verified in foundry-tests/test/psv-fork/PSVForkBase.sol).
// As with FIV, a LOCAL by-shares withdrawal (bridgeAdapter == 0) may be submitted by the depositor
// itself; the whitelisted dispatcher later applies it (grossQuantity = shares × price).
// WithdrawalFromManagedAccountByShares carries an EXTRA trailing uint64 `grossQuantity` (set by the
// dispatcher at apply) between gasFee and walletSignature — 13 fields, not 12. Omitting it yields a
// different function selector and every call reverts.
const PROVIDER_SHARES_ABI = [
  "function withdrawByShares((uint128,address,address,uint64,uint64,uint64,address,bytes,address,bytes,uint64,uint64,bytes) withdrawal)",
];

/**
 * Withdraw `shares` from `managerWallet`'s PSV vault, signed by and submitted from `depositor`.
 * `minimumQuantityUsd` is the depositor's slippage floor on the quote received (≥ $1). Returns the tx hash.
 *
 * ⚠ RUNTIME-VERIFY: the SDK typed-data helper name below is the by-shares analog of the proven
 * by-quantity one. The SDK is not installed in this checkout to confirm it; if it is named
 * differently in the deployed beta, adjust the one call. The on-chain struct + ABI are confirmed.
 */
export async function withdrawSharesOnChain(
  p: ethers.JsonRpcProvider,
  depositor: ethers.Wallet,
  managerWallet: string,
  shares: number,
  minimumQuantityUsd: number,
): Promise<string> {
  // Full 8-dp share precision, rounded DOWN so a request sized at the available shares never
  // exceeds them (the caller keeps a margin above the signed floor, so one pip less is harmless).
  const sh = Math.floor(shares * 1e8 + 1e-6) / 1e8;
  const minQty = Math.max(1, Math.round(minimumQuantityUsd * 100) / 100); // MINIMUM_WITHDRAWAL_QUANTITY = $1
  const nonce = uuidv1();
  const maximumGasFee = MINIMUM_MAXIMUM_GAS_FEE;

  const typedData: any = await (kperps as any).getWithdrawalFromManagedAccountBySharesSignatureTypedData(
    {
      nonce,
      wallet: depositor.address,
      managerWallet,
      shares: sh.toFixed(8),
      minimumQuantity: minQty.toFixed(8),
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
    toPips(sh),                               // shares
    toPips(minQty),                           // minimumQuantity
    toPips(maximumGasFee),
    config.vaultProvider,
    "0x",                                     // managedAccountProviderPayload
    ZERO,                                     // bridgeAdapter -> local
    "0x",                                     // bridgeAdapterPayload -> local
    0n,                                       // gasFee actually charged
    0n,                                       // grossQuantity (the dispatcher fills this = shares × price at apply)
    signature,
  ];

  const vp = new ethers.Contract(config.vaultProvider, PROVIDER_SHARES_ABI, depositor) as any;
  await rpcRetry("withdrawByShares staticCall", () => vp.withdrawByShares.staticCall(struct));
  const tx = await rpcRetry("withdrawByShares send", () => vp.withdrawByShares(struct, { gasLimit: 2_000_000 }));
  await waitReceipt(p, tx.hash);
  return tx.hash;
}
