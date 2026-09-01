/**
 * vault.ts — on-chain vault creation, deposits, and state reads.
 *
 * Ported from the proven foundry-tests/ops flow rather than written fresh, because this path has
 * two failure modes that are easy to reintroduce:
 *
 *  1. A deposit fired too soon after creation ComposeFails — the vault rejects it, the adapter
 *     re-credits the depositor's EXCHANGE balance, and `owed` silently stays 0. Hence the settle
 *     delay plus retry-while-the-funds-are-still-on-chain.
 *  2. `addManagedAccount` reverts INSIDE the compose call on a bad config, so the only signal is a
 *     ComposeFailed event and a seed sitting in the manager's exchange balance. Hence polling
 *     loadVaultSummary for real liveness instead of trusting the tx receipt.
 *
 * Settlement is confirmed from vault STATE (numDepositorWallets / pending), never from "totalOwed
 * went up" — accrued interest alone satisfies that and reports false success.
 */
import { DepositBridgeAdapterPayloadType, encodeFixedIncomeVaultConfigurationFields } from "@katanaperps/katana-perps-sdk";
import { ethers } from "ethers";
import { config } from "./config.js";

export const PIPS = 1e8;
export const USDC_DECIMALS = 6;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const VAULT_ABI = [
  "function loadVaultSummary(address) view returns ((bool,bool,bool,bool,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64))",
  "function loadVaultBalanceForWalletSummary(address,address) view returns ((uint64,uint64,uint64,uint64,uint64,uint64,uint64))",
  "function loadVaultWithdrawQueueLength(address) view returns (uint256)",
];
// VaultSummary word map — the indices that matter, and the trap that cost a retracted finding:
//   [0] isActive [1] isExited [2] isLiquidated
//   [9] depositorNetDeposits [10] numDepositorWallets [12] totalOwedQuantity [13] depositorPendingDeposit
// NOT [6] (exitedDepositorPending) — reading that as totalOwed produces a phantom "owed=0".
// VaultBalanceForWalletSummary: [0] costBasis (principal only), [2] lockedQuantity,
//   [3] owedQuantity (INCLUDES accrued interest), [4] pendingDepositQuantity,
//   [5] quantityAvailableToWithdraw.

// The deposit adapter, by minimal ABI rather than via
// @katanaperps/katana-perps-contracts-niseko-ma. That package is NOT on the public npm registry
// (404 anonymously), so depending on it would force registry credentials into the Docker build and
// into CI. The wrapper adds nothing here beyond this one call: calldata produced by this fragment
// is byte-identical to the package's (verified against its typechain ABI, selector 0x5d303519).
const ADAPTER_ABI = ["function deposit(uint256 quoteAssetQuantityInAssetUnits, bytes payload)"];
const adapterFor = (signer: ethers.Wallet) =>
  new ethers.Contract(config.depositAdapter, ADAPTER_ABI, signer) as any;

export function provider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: true });
}

export async function waitReceipt(p: ethers.JsonRpcProvider, hash: string) {
  const rc = await p.waitForTransaction(hash, 1, 120_000);
  if (!rc || rc.status !== 1) throw new Error(`tx ${hash} failed (status ${rc?.status})`);
  return rc;
}

/** Top a wallet up to the requested ETH / vbUSDC from the funding wallet. Idempotent. */
export async function ensureFunded(p: ethers.JsonRpcProvider, to: string, ethAmt: string, usdAmt: string) {
  const funding = new ethers.Wallet(config.fundingKey, p);
  if ((await p.getBalance(to)) < ethers.parseEther(ethAmt)) {
    await waitReceipt(p, (await funding.sendTransaction({ to, value: ethers.parseEther(ethAmt) })).hash);
  }
  const vb = new ethers.Contract(config.quoteToken,
    ["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], funding) as any;
  const want = ethers.parseUnits(usdAmt, USDC_DECIMALS);
  if ((await vb.balanceOf(to)) < want) await waitReceipt(p, (await vb.transfer(to, want)).hash);
}

/**
 * Is there already a live vault for this manager? Provisioning must check FIRST: a second
 * `addManagedAccount` for the same manager reverts Duplicate INSIDE the compose call, which does
 * not throw — the adapter re-credits the seed to the manager's exchange balance and you get a
 * ComposeFailed event. So a naive re-run silently costs another seed and creates nothing.
 */
export async function existingVault(p: ethers.JsonRpcProvider, managerAddr: string) {
  const vp = new ethers.Contract(config.vaultProvider, VAULT_ABI, p) as any;
  try {
    const s = await vp.loadVaultSummary(managerAddr);
    return { exists: true, isActive: Boolean(s[0]), isExited: Boolean(s[1]), isLiquidated: Boolean(s[2]),
             numDepositorWallets: Number(s[10]), totalOwed: Number(s[12]) / PIPS,
             depositorNetDeposits: Number(s[9]) / PIPS };
  } catch (e: any) {
    // 0xe64a6a36 = provider's "no vault for this manager wallet". Anything else is a real fault
    // and must not be mistaken for "safe to create".
    const d = String(e?.data ?? e?.info?.error?.data ?? "");
    if (d.startsWith("0xe64a6a36")) return { exists: false } as any;
    throw new Error(`could not determine whether a vault exists for ${managerAddr}: ${e?.message ?? e}`);
  }
}

export async function createVault(
  p: ethers.JsonRpcProvider,
  opts: { manager: ethers.Wallet; seedUsd: number; fields: Record<string, any>; log: (m: string) => void },
): Promise<boolean> {
  const { manager, seedUsd, fields, log } = opts;
  const cfg = encodeFixedIncomeVaultConfigurationFields({
    managerWallet: manager.address, effectiveTimestampInS: 0, ...fields,
  });
  const payload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint8", "tuple(uint32,address,address,bytes,bytes)"],
    [DepositBridgeAdapterPayloadType.addManagedAccount,
     [config.lzEndpointId, config.vaultProvider, manager.address, cfg, "0x"]],
  );
  const vb = new ethers.Contract(config.quoteToken, ["function approve(address,uint256) returns (bool)"], manager) as any;
  await waitReceipt(p, (await vb.approve(config.depositAdapter, ethers.parseUnits(String(seedUsd + 10), USDC_DECIMALS))).hash);
  await waitReceipt(p, (await adapterFor(manager)
    .deposit(ethers.parseUnits(String(seedUsd), USDC_DECIMALS), payload)).hash);
  log(`  addManagedAccount submitted (seed $${seedUsd}); polling for apply…`);
  const vp = new ethers.Contract(config.vaultProvider, VAULT_ABI, p) as any;
  for (let i = 0; i < 16; i++) {
    try { const s = await vp.loadVaultSummary(manager.address); if (s[0] && !s[1] && !s[2]) return true; } catch {}
    await sleep(5000);
  }
  return false;
}

/**
 * Deposit into the vault. Confirms from vault state, not from totalOwed rising.
 * `expectDepositors` is the numDepositorWallets value that proves THIS deposit applied; pass the
 * current count for a top-up by an existing depositor (the count will not change).
 */
export async function depositTo(
  p: ethers.JsonRpcProvider,
  opts: { managerAddr: string; dep: ethers.Wallet; amountUsd: number; expectDepositors: number;
          settleMs: number; attempts?: number; log: (m: string) => void },
): Promise<boolean> {
  const { managerAddr, dep, amountUsd, expectDepositors, settleMs, log } = opts;
  const attempts = opts.attempts ?? 3;
  const vp = new ethers.Contract(config.vaultProvider, VAULT_ABI, p) as any;
  const amt = ethers.parseUnits(String(amountUsd), USDC_DECIMALS);
  const before = await vaultBalance(p, managerAddr, dep.address);
  await sleep(settleMs);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const vb = new ethers.Contract(config.quoteToken,
      ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], dep) as any;
    const onchain: bigint = await vb.balanceOf(dep.address).catch(() => 0n);
    if (onchain < amt) {
      log(`  ! ${dep.address} holds ${ethers.formatUnits(onchain, USDC_DECIMALS)} < ${amountUsd} on-chain — a prior `
        + `attempt ComposeFailed and diverted into its exchange balance; cannot re-deposit`);
      return false;
    }
    await waitReceipt(p, (await vb.approve(config.depositAdapter, amt)).hash);
    const payload = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint8", "tuple(uint32,address,address,address,bytes)"],
      [DepositBridgeAdapterPayloadType.depositToManagedAccount,
       [config.lzEndpointId, dep.address, config.vaultProvider, managerAddr, "0x"]],
    );
    await waitReceipt(p, (await adapterFor(dep).deposit(amt, payload)).hash);

    for (let i = 0; i < 12; i++) {
      try {
        const s = await vp.loadVaultSummary(managerAddr);
        const bal = await vaultBalance(p, managerAddr, dep.address);
        // Applied when nothing is left pending AND this wallet's principal actually moved.
        if (Number(s[13]) === 0 && Number(s[10]) >= expectDepositors && bal.costBasis > before.costBasis + 0.001) return true;
      } catch {}
      await sleep(5000);
    }
    log(`  ! attempt ${attempt} did not settle (compose race) — settling and retrying`);
    await sleep(settleMs);
  }
  return false;
}

export async function vaultBalance(p: ethers.JsonRpcProvider, managerAddr: string, wallet: string) {
  const vp = new ethers.Contract(config.vaultProvider, VAULT_ABI, p) as any;
  try {
    const b = await vp.loadVaultBalanceForWalletSummary(managerAddr, wallet);
    return {
      costBasis: Number(b[0]) / PIPS, locked: Number(b[2]) / PIPS, owed: Number(b[3]) / PIPS,
      pendingDeposit: Number(b[4]) / PIPS, availableToWithdraw: Number(b[5]) / PIPS,
    };
  } catch { return { costBasis: 0, locked: 0, owed: 0, pendingDeposit: 0, availableToWithdraw: 0 }; }
}

/** Read vault state at a PINNED block so aggregate and per-wallet reads are mutually consistent. */
export async function readVault(p: ethers.JsonRpcProvider, managerAddr: string, depositors: string[]) {
  const vp = new ethers.Contract(config.vaultProvider, VAULT_ABI, p) as any;
  // Both views accrue interest to block.timestamp; reading them in separate calls against "latest"
  // manufactures drift that looks like an accounting bug. Pin one block for all of them.
  const pin = await p.getBlockNumber();
  const s = await vp.loadVaultSummary(managerAddr, { blockTag: pin });
  const per: { address: string; owed: number; costBasis: number }[] = [];
  for (const d of depositors) {
    const b = await vp.loadVaultBalanceForWalletSummary(managerAddr, d, { blockTag: pin });
    per.push({ address: d, owed: Number(b[3]) / PIPS, costBasis: Number(b[0]) / PIPS });
  }
  return {
    pin, isActive: Boolean(s[0]), isExited: Boolean(s[1]), isLiquidated: Boolean(s[2]),
    depositorNetDeposits: Number(s[9]) / PIPS, numDepositorWallets: Number(s[10]),
    totalOwed: Number(s[12]) / PIPS, depositorPending: Number(s[13]) / PIPS,
    perDepositor: per.filter((x) => x.owed > 0 || x.costBasis > 0),
    deltaPips: Math.round(per.reduce((a, x) => a + x.owed, 0) * PIPS) - Number(s[12]),
  };
}
