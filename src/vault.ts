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

/**
 * Retry an RPC call with backoff.
 *
 * The public Bokuto endpoint rate-limits under sustained load, and it does so as a JSON-RPC
 * error INSIDE a 200 response (code -32017), not an HTTP 429 — so ethers' own throttling never
 * sees it and the call just throws. Provisioning several vaults back to back reliably trips it,
 * and without this a single throttle response aborts a run that has already created the vault
 * on-chain, leaving it half-seeded.
 *
 * Retries anything transient: rate limits, timeouts, connection resets, "coalesce" batch
 * failures. A genuine revert is re-thrown immediately — retrying it would just waste time.
 */
export async function rpcRetry<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  let last: any;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e: any) {
      last = e;
      const msg = `${e?.message ?? ""} ${e?.info?.error?.message ?? ""} ${e?.error?.message ?? ""}`;
      const transient = /rate limit|-32017|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket|coalesce|502|503|504|SERVER_ERROR|NETWORK_ERROR/i.test(msg);
      // A revert is deterministic — never retry it.
      const reverted = /execution reverted|CALL_EXCEPTION/i.test(msg) && !/coalesce/i.test(msg);
      if (!transient || reverted || i === attempts - 1) throw e;
      const wait = Math.min(1500 * 2 ** i, 20000);
      console.log(`  … ${label} rate-limited/transient (attempt ${i + 1}/${attempts}) — retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw last;
}

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

// ── Profit-Share Vault (PSV) view surface ───────────────────────────────────
// PSV has NO owed/interest model — a depositor holds SHARES and the vault has a share PRICE; a
// wallet's value = shares × price (there is no "owed"). ABI confirmed against the deployed dev PSV
// provider. loadVaultSummary word map: [0] isDepositEnabled [1] isExited [2] isLiquidated
// [3] configFields-tuple [8] depositorNetDeposits [10] numDepositorWallets [11] sharePrice
// [12] totalShares. loadVaultBalanceForWallet: [0] costBasis [3] pendingDepositQuantity [5] totalShares.
export const PSV_VAULT_ABI = [
  "function loadVaultSummary(address) view returns ((bool,bool,bool,(address,uint64,uint64,uint64,uint64,uint64,uint64),uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64))",
  "function loadVaultBalanceForWallet(address,address) view returns ((uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64))",
  "function loadSharePrice(address) view returns (uint64)",
  "function loadVaultWithdrawQueueLength(address) view returns (uint256)",
];
export const isPsv = () => config.vaultType === "PSV";
const abiFor = () => (isPsv() ? PSV_VAULT_ABI : VAULT_ABI);

/** Hand-encode the 7-field PSV VaultConfigurationFields tuple (the SDK ships no PSV encoder; its PSV
 *  typechain struct does not match the deployed provider). Field order matches the on-chain struct. */
export function encodePsvConfig(managerWallet: string, f: Record<string, any>): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(address,uint64,uint64,uint64,uint64,uint64,uint64)"],
    [[managerWallet, f.carryFeeMultiplier, f.managementFeeMultiplier, f.maximumNetDeposits,
      f.minimumUnappliedDepositOrWithdrawalAgeInSToInitiateExit, f.withdrawalLimitPercentForDepositors,
      f.withdrawalLimitPercentForVault]],
  );
}

export function provider(): ethers.JsonRpcProvider {
  // FetchRequest rather than a bare URL so the access key can travel as a header. Without a key
  // the public endpoint rate-limits as a JSON-RPC error inside a 200 response (-32017), which
  // ethers' own throttling cannot see — hence rpcRetry below.
  const fr = new ethers.FetchRequest(config.rpcUrl);
  fr.setHeader("User-Agent", "ikon-vaultgen");
  if (config.rpcAccessKey) fr.setHeader("X-AccessKey", config.rpcAccessKey);
  return new ethers.JsonRpcProvider(fr, undefined, { staticNetwork: true });
}

export async function waitReceipt(p: ethers.JsonRpcProvider, hash: string) {
  const rc = await rpcRetry(`waitForTransaction ${hash.slice(0, 10)}`, () => p.waitForTransaction(hash, 1, 120_000));
  if (!rc || rc.status !== 1) throw new Error(`tx ${hash} failed (status ${rc?.status})`);
  return rc;
}

/** Top a wallet up to the requested ETH / vbUSDC from the funding wallet. Idempotent. */
export async function ensureFunded(p: ethers.JsonRpcProvider, to: string, ethAmt: string, usdAmt: string) {
  const funding = new ethers.Wallet(config.fundingKey, p);
  const ethBal = await rpcRetry("getBalance", () => p.getBalance(to));
  if (ethBal < ethers.parseEther(ethAmt)) {
    await waitReceipt(p, (await rpcRetry("sendTransaction ETH", () => funding.sendTransaction({ to, value: ethers.parseEther(ethAmt) }))).hash);
  }
  const vb = new ethers.Contract(config.quoteToken,
    ["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], funding) as any;
  const want = ethers.parseUnits(Number(usdAmt).toFixed(2), USDC_DECIMALS);
  const usdBal = await rpcRetry("balanceOf", () => vb.balanceOf(to));
  if (usdBal < want) await waitReceipt(p, (await rpcRetry("transfer vbUSDC", () => vb.transfer(to, want))).hash);
}

/**
 * Is there already a live vault for this manager? Provisioning must check FIRST: a second
 * `addManagedAccount` for the same manager reverts Duplicate INSIDE the compose call, which does
 * not throw — the adapter re-credits the seed to the manager's exchange balance and you get a
 * ComposeFailed event. So a naive re-run silently costs another seed and creates nothing.
 */
export async function existingVault(p: ethers.JsonRpcProvider, managerAddr: string) {
  const vp = new ethers.Contract(config.vaultProvider, abiFor(), p) as any;
  try {
    const s = await rpcRetry("loadVaultSummary", () => vp.loadVaultSummary(managerAddr));
    if (isPsv()) {
      // PSV: no "owed" — report the vault's total VALUE (totalShares × sharePrice) in its place.
      const value = (Number(s[12]) / PIPS) * (Number(s[11]) / PIPS);
      return { exists: true, isActive: !Boolean(s[1]) && !Boolean(s[2]), isExited: Boolean(s[1]), isLiquidated: Boolean(s[2]),
               numDepositorWallets: Number(s[10]), totalOwed: value,
               depositorNetDeposits: Number(s[8]) / PIPS };
    }
    return { exists: true, isActive: Boolean(s[0]), isExited: Boolean(s[1]), isLiquidated: Boolean(s[2]),
             numDepositorWallets: Number(s[10]), totalOwed: Number(s[12]) / PIPS,
             depositorNetDeposits: Number(s[9]) / PIPS };
  } catch (e: any) {
    // dev/sandbox revert the provider's "no vault for this manager wallet" custom error.
    const d = String(e?.data ?? e?.info?.error?.data ?? "");
    if (d.startsWith("0xe64a6a36")) return { exists: false } as any;

    // staging reverts the same condition with NO revert data at all, so the selector check
    // is not portable. Rather than guess at encodings, confirm the provider is actually
    // answering: if a known-good view responds, the contract is healthy and the failure above
    // means "this manager has no vault". If it does not, the fault is real and must not be
    // mistaken for "safe to create" — creating a second vault costs another seed.
    try {
      const probe = new ethers.Contract(config.vaultProvider,
        ["function isAddManagedAccountEnabled() view returns (bool)"], p) as any;
      await rpcRetry("provider liveness probe", () => probe.isAddManagedAccountEnabled());
      return { exists: false } as any;
    } catch {
      throw new Error(`could not determine whether a vault exists for ${managerAddr} — the provider `
        + `at ${config.vaultProvider} is not answering reads: ${e?.message ?? e}`);
    }
  }
}

export async function createVault(
  p: ethers.JsonRpcProvider,
  opts: { manager: ethers.Wallet; seedUsd: number; fields: Record<string, any>; log: (m: string) => void },
): Promise<boolean> {
  const { manager, seedUsd, fields, log } = opts;
  // FIV uses the SDK encoder (9-field, with effectiveTimestampInS); PSV hand-encodes the 7-field tuple.
  const cfg = isPsv()
    ? encodePsvConfig(manager.address, fields)
    : encodeFixedIncomeVaultConfigurationFields({ managerWallet: manager.address, effectiveTimestampInS: 0, ...fields });
  const payload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint8", "tuple(uint32,address,address,bytes,bytes)"],
    [DepositBridgeAdapterPayloadType.addManagedAccount,
     [config.lzEndpointId, config.vaultProvider, manager.address, cfg, "0x"]],
  );
  const vb = new ethers.Contract(config.quoteToken, ["function approve(address,uint256) returns (bool)"], manager) as any;
  await waitReceipt(p, (await rpcRetry("approve seed", () => vb.approve(config.depositAdapter, ethers.parseUnits(String(seedUsd + 10), USDC_DECIMALS)))).hash);
  await waitReceipt(p, (await rpcRetry("adapter deposit (create)", () => adapterFor(manager)
    .deposit(ethers.parseUnits(String(seedUsd), USDC_DECIMALS), payload))).hash);
  log(`  addManagedAccount submitted (seed $${seedUsd}); polling for apply…`);
  const vp = new ethers.Contract(config.vaultProvider, abiFor(), p) as any;
  for (let i = 0; i < 16; i++) {
    try {
      if (isPsv()) {
        // PSV liveness = the manager's seed minted shares (loadVaultBalanceForWallet[5]). Proven live.
        const b = await rpcRetry("loadVaultBalanceForWallet", () => vp.loadVaultBalanceForWallet(manager.address, manager.address));
        if (BigInt(b[5]) > 0n) return true;
      } else {
        const s = await rpcRetry("loadVaultSummary", () => vp.loadVaultSummary(manager.address));
        if (s[0] && !s[1] && !s[2]) return true;
      }
    } catch {}
    await sleep(6000);
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
  const vp = new ethers.Contract(config.vaultProvider, abiFor(), p) as any;
  // depositorPendingDepositQuantity is word [13] on the FIV summary, [9] on the PSV summary.
  const pendingIdx = isPsv() ? 9 : 13;
  // Pin to 2dp here rather than trusting callers: any float arithmetic upstream
  // (headroom subtraction, percentage of owed) can produce 9.379999999999999, which
  // parseUnits rejects outright.
  const amt = ethers.parseUnits(amountUsd.toFixed(2), USDC_DECIMALS);
  const before = await vaultBalance(p, managerAddr, dep.address);
  await sleep(settleMs);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const vb = new ethers.Contract(config.quoteToken,
      ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], dep) as any;
    const onchain: bigint = await rpcRetry("balanceOf dep", () => vb.balanceOf(dep.address)).catch(() => 0n);
    if (onchain < amt) {
      log(`  ! ${dep.address} holds ${ethers.formatUnits(onchain, USDC_DECIMALS)} < ${amountUsd} on-chain — a prior `
        + `attempt ComposeFailed and diverted into its exchange balance; cannot re-deposit`);
      return false;
    }
    await waitReceipt(p, (await rpcRetry("approve deposit", () => vb.approve(config.depositAdapter, amt))).hash);
    const payload = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint8", "tuple(uint32,address,address,address,bytes)"],
      [DepositBridgeAdapterPayloadType.depositToManagedAccount,
       [config.lzEndpointId, dep.address, config.vaultProvider, managerAddr, "0x"]],
    );
    await waitReceipt(p, (await rpcRetry("adapter deposit", () => adapterFor(dep).deposit(amt, payload))).hash);

    for (let i = 0; i < 12; i++) {
      try {
        const s = await rpcRetry("loadVaultSummary", () => vp.loadVaultSummary(managerAddr));
        const bal = await vaultBalance(p, managerAddr, dep.address);
        // Applied when nothing is left pending AND this wallet's principal actually moved.
        if (Number(s[pendingIdx]) === 0 && Number(s[10]) >= expectDepositors && bal.costBasis > before.costBasis + 0.001) return true;
      } catch {}
      await sleep(6000);
    }
    log(`  ! attempt ${attempt} did not settle (compose race) — settling and retrying`);
    await sleep(settleMs);
  }
  return false;
}

export async function vaultBalance(p: ethers.JsonRpcProvider, managerAddr: string, wallet: string) {
  const vp = new ethers.Contract(config.vaultProvider, abiFor(), p) as any;
  try {
    if (isPsv()) {
      // PSV: a wallet holds shares; value = shares × sharePrice. No locked/owed; map owed→value so
      // downstream reporting/churn reads one field. loadVaultBalanceForWallet: [0] costBasis [3] pending [5] shares.
      const b = await rpcRetry("loadVaultBalance", () => vp.loadVaultBalanceForWallet(managerAddr, wallet));
      const price = Number(await rpcRetry("loadSharePrice", () => vp.loadSharePrice(managerAddr))) / PIPS;
      const value = (Number(b[5]) / PIPS) * price;
      return {
        costBasis: Number(b[0]) / PIPS, locked: 0, owed: value,
        pendingDeposit: Number(b[3]) / PIPS, availableToWithdraw: value,
      };
    }
    const b = await rpcRetry("loadVaultBalance", () => vp.loadVaultBalanceForWalletSummary(managerAddr, wallet));
    return {
      costBasis: Number(b[0]) / PIPS, locked: Number(b[2]) / PIPS, owed: Number(b[3]) / PIPS,
      pendingDeposit: Number(b[4]) / PIPS, availableToWithdraw: Number(b[5]) / PIPS,
    };
  } catch { return { costBasis: 0, locked: 0, owed: 0, pendingDeposit: 0, availableToWithdraw: 0 }; }
}

/** Read vault state at a PINNED block so aggregate and per-wallet reads are mutually consistent. */
export async function readVault(p: ethers.JsonRpcProvider, managerAddr: string, depositors: string[]) {
  const vp = new ethers.Contract(config.vaultProvider, abiFor(), p) as any;
  // Both views accrue (interest for FIV, management fee for PSV) to block.timestamp; reading them in
  // separate calls against "latest" manufactures drift that looks like an accounting bug. Pin one block.
  const pin = await rpcRetry("getBlockNumber", () => p.getBlockNumber());
  const s = await rpcRetry("loadVaultSummary pinned", () => vp.loadVaultSummary(managerAddr, { blockTag: pin }));

  if (isPsv()) {
    // PSV: `owed` is replaced by VALUE = shares × sharePrice. The FIV owed==sum(perWallet) invariant
    // does not apply (share price is a single oracle-derived number), so deltaPips is 0.
    const price = Number(await rpcRetry("loadSharePrice pinned", () => vp.loadSharePrice(managerAddr, { blockTag: pin }))) / PIPS;
    const per: { address: string; owed: number; costBasis: number }[] = [];
    for (const d of depositors) {
      const b = await rpcRetry("loadVaultBalance pinned", () => vp.loadVaultBalanceForWallet(managerAddr, d, { blockTag: pin }));
      per.push({ address: d, owed: (Number(b[5]) / PIPS) * price, costBasis: Number(b[0]) / PIPS });
    }
    return {
      pin, isActive: !Boolean(s[1]) && !Boolean(s[2]), isExited: Boolean(s[1]), isLiquidated: Boolean(s[2]),
      depositorNetDeposits: Number(s[8]) / PIPS, numDepositorWallets: Number(s[10]),
      totalOwed: (Number(s[12]) / PIPS) * price, depositorPending: Number(s[9]) / PIPS, sharePrice: price,
      perDepositor: per.filter((x) => x.owed > 0 || x.costBasis > 0), deltaPips: 0,
    };
  }

  const per: { address: string; owed: number; costBasis: number }[] = [];
  for (const d of depositors) {
    const b = await rpcRetry("loadVaultBalance pinned", () => vp.loadVaultBalanceForWalletSummary(managerAddr, d, { blockTag: pin }));
    per.push({ address: d, owed: Number(b[3]) / PIPS, costBasis: Number(b[0]) / PIPS });
  }
  return {
    pin, isActive: Boolean(s[0]), isExited: Boolean(s[1]), isLiquidated: Boolean(s[2]),
    depositorNetDeposits: Number(s[9]) / PIPS, numDepositorWallets: Number(s[10]),
    totalOwed: Number(s[12]) / PIPS, depositorPending: Number(s[13]) / PIPS, sharePrice: 0,
    perDepositor: per.filter((x) => x.owed > 0 || x.costBasis > 0),
    deltaPips: Math.round(per.reduce((a, x) => a + x.owed, 0) * PIPS) - Number(s[12]),
  };
}
