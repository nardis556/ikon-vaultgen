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
// providers (tag .3 and the 2026-10-20 signed one). loadVaultBalanceForWallet: [0] costBasis
// [3] pendingDepositQuantity [5] totalShares. loadVaultSummary is NOT in this list: its layout
// differs between provider versions, so read it through psvSummary() below, by field name.
export const PSV_VAULT_ABI = [
  "function loadVaultBalanceForWallet(address,address) view returns ((uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64))",
  // Summary view that NETS the withdrawal-limit windows: [0] costBasis [2] pendingDeposit
  // [3] sharesAvailableToWithdraw (window-netted) [4] sharesLockedForWithdrawal [5] totalShares.
  "function loadVaultBalanceForWalletSummary(address,address) view returns ((uint64,uint64,uint64,uint64,uint64,uint64,uint64))",
  "function loadSharePrice(address) view returns (uint64)",
  "function loadVaultWithdrawQueueLength(address) view returns (uint256)",
];
export const isPsv = () => config.vaultType === "PSV";
const abiFor = () => (isPsv() ? PSV_VAULT_ABI : VAULT_ABI);

// PSV VaultSummary words after the 7-word configurationFields tuple. The providers deployed
// 2026-10-20 insert exchangeCarryFeeMultiplier before them (20 words in all, 19 before), which
// moves every one down an index. Fixed indices then read the wrong field without any error — the
// old [8] "depositorNetDeposits" becomes exitedTotalShares (0), so churn saw the whole deposit cap
// as free headroom. The word count says which layout the provider returns.
const PSV_SUMMARY_TAIL = ["exitedAccountValue", "exitedAtTimestampInS", "exitedPendingDepositQuantity",
  "exitedTotalShares", "depositorNetDeposits", "depositorPendingDepositQuantity", "numDepositorWallets",
  "sharePrice", "totalShares"] as const;
export type PsvSummary = { isDepositEnabled: boolean; isExited: boolean; isLiquidated: boolean }
  & Record<(typeof PSV_SUMMARY_TAIL)[number], number>;
const SUMMARY_CALL = new ethers.Interface(["function loadVaultSummary(address)"]);

/** PSV loadVaultSummary by field name (raw pips / counts). Reverts propagate with their data. */
export async function psvSummary(p: ethers.JsonRpcProvider, managerAddr: string, blockTag?: number): Promise<PsvSummary> {
  const raw = await rpcRetry("loadVaultSummary", () => p.call({ to: config.vaultProvider, blockTag,
    data: SUMMARY_CALL.encodeFunctionData("loadVaultSummary", [managerAddr]) }));
  const carryWord = (raw.length - 2) / 64 === 20;
  const v = ethers.AbiCoder.defaultAbiCoder().decode(["bool", "bool", "bool",
    "tuple(address,uint64,uint64,uint64,uint64,uint64,uint64)", ...(carryWord ? ["uint64"] : []),
    ...PSV_SUMMARY_TAIL.map(() => "uint64")], raw);
  const tail = v.slice(carryWord ? 5 : 4);
  return { isDepositEnabled: Boolean(v[0]), isExited: Boolean(v[1]), isLiquidated: Boolean(v[2]),
    ...Object.fromEntries(PSV_SUMMARY_TAIL.map((k, i) => [k, Number(tail[i])])) } as PsvSummary;
}

// ── Signed creation ─────────────────────────────────────────────────────────
// The providers deployed 2026-10-20 create a vault only if the manager wallet signed its
// configuration: EIP-712 over the VaultConfigurationFields struct, field for field, and the payload
// becomes abi.encode(config, signature) instead of abi.encode(config). They expose eip712Domain();
// the earlier providers have no such function, so the provider itself says which payload it takes.
// (FIV's effectiveTimestampInS is signed but not checked against the clock — 0 is accepted.)
const SIGNED_CONFIG: Record<"FIV" | "PSV", { type: string; fields: [string, string][] }> = {
  FIV: { type: "FixedIncomeVaultConfiguration", fields: [["managerWallet", "address"], ["effectiveTimestampInS", "uint64"],
    ["interestMultiplier", "uint64"], ["maximumNetDeposits", "uint64"],
    ["maximumTotalOwedQuantityAvailableMultiplierToInitiateExit", "uint64"],
    ["minimumTotalOwedQuantityAvailableMultiplierToAllowManagerWalletWithdrawal", "uint64"],
    ["minimumUnappliedDepositOrWithdrawalAgeInSToInitiateExit", "uint64"],
    ["withdrawalLimitPercentForDepositors", "uint64"], ["withdrawalLimitPercentForVault", "uint64"]] },
  PSV: { type: "ProfitShareVaultConfiguration", fields: [["managerWallet", "address"], ["carryFeeMultiplier", "uint64"],
    ["managementFeeMultiplier", "uint64"], ["maximumNetDeposits", "uint64"],
    ["minimumUnappliedDepositOrWithdrawalAgeInSToInitiateExit", "uint64"],
    ["withdrawalLimitPercentForDepositors", "uint64"], ["withdrawalLimitPercentForVault", "uint64"]] },
};

async function signingDomain(p: ethers.JsonRpcProvider): Promise<ethers.TypedDataDomain | null> {
  const c = new ethers.Contract(config.vaultProvider,
    ["function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])"], p) as any;
  try {
    const d = await rpcRetry("eip712Domain", () => c.eip712Domain());
    return { name: d[1], version: d[2], chainId: Number(d[3]), verifyingContract: d[4] };
  } catch (e: any) {
    if (e?.code === "CALL_EXCEPTION") return null;   // no eip712Domain(): a provider that takes the unsigned payload
    throw e;
  }
}

/** The provider's addManagedAccount payload for this config: signed by the manager when the provider requires it. */
async function createPayload(p: ethers.JsonRpcProvider, manager: ethers.Wallet, cfg: string, log: (m: string) => void) {
  const domain = await signingDomain(p);
  if (!domain) return cfg;
  const { type, fields } = SIGNED_CONFIG[config.vaultType];
  const tupleType = `tuple(${fields.map((f) => f[1]).join(",")})`;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const values = Array.from(coder.decode([tupleType], cfg)[0] as any[]);
  const signature = await manager.signTypedData(domain, { [type]: fields.map(([name, t]) => ({ name, type: t })) },
    Object.fromEntries(fields.map(([name], i) => [name, values[i]])));
  log(`  configuration signed by the manager (EIP-712 "${domain.name}" ${domain.version})`);
  return coder.encode([tupleType, "bytes"], [values, signature]);
}

// Errors worth naming when the creation pre-check refuses a payload (everything else prints its selector).
const CREATE_ERRORS = new ethers.Interface([
  "error InvalidWalletSignature()", "error ECDSAInvalidSignature()", "error ECDSAInvalidSignatureLength(uint256)",
  "error ECDSAInvalidSignatureS(bytes32)", "error NonceTimestampSkewOutOfRange(uint64,uint64,uint64)",
  "error ManagementFeeMultiplierOutOfRange(uint64,uint64,uint64)", "error CarryFeeMultiplierOutOfRange(uint64,uint64,uint64)",
  "error MaximumNetDepositsOutOfRange(uint64,uint64,uint64)", "error Duplicate()", "error SenderMustBeExchangeBridgeAdapter()",
]);

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
  const read = () => (isPsv() ? psvSummary(p, managerAddr) : vp.loadVaultSummary(managerAddr));
  const parse = (s: any) => {
    if (isPsv()) {
      // PSV: no "owed" — report the vault's total VALUE (totalShares × sharePrice) in its place.
      const value = (s.totalShares / PIPS) * (s.sharePrice / PIPS);
      return { exists: true, isActive: !s.isExited && !s.isLiquidated, isExited: s.isExited, isLiquidated: s.isLiquidated,
               numDepositorWallets: s.numDepositorWallets, totalOwed: value,
               depositorNetDeposits: s.depositorNetDeposits / PIPS };
    }
    return { exists: true, isActive: Boolean(s[0]), isExited: Boolean(s[1]), isLiquidated: Boolean(s[2]),
             numDepositorWallets: Number(s[10]), totalOwed: Number(s[12]) / PIPS,
             depositorNetDeposits: Number(s[9]) / PIPS };
  };
  try {
    return parse(await rpcRetry("loadVaultSummary", read));
  } catch (e: any) {
    // dev/sandbox revert the provider's "no vault for this manager wallet" custom error.
    const d = String(e?.data ?? e?.info?.error?.data ?? "");
    if (d.startsWith("0xe64a6a36")) return { exists: false } as any;

    // staging reverts the same condition with NO revert data at all, so the selector check
    // is not portable. Rather than guess at encodings, confirm the provider is actually
    // answering: if a known-good view responds, the contract is healthy and the failure above
    // means "this manager has no vault". If it does not, the fault is real and must not be
    // mistaken for "safe to create" — creating a second vault costs another seed.
    //
    // A rate-limited read can also fail with no revert data, so one data-less failure is not
    // enough: on dev (2026-10-15, three provisioning runs sharing the public RPC) it misread two
    // live vaults as missing, and the resumed provisions created duplicates and re-seeded their
    // depositors. Re-read a few times, spaced out, before believing "no vault".
    for (let i = 0; i < 3; i++) {
      await sleep(5000);
      try { return parse(await read()); } catch (e2: any) {
        if (String(e2?.data ?? e2?.info?.error?.data ?? "").startsWith("0xe64a6a36")) return { exists: false } as any;
      }
    }
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
  const providerPayload = await createPayload(p, manager, cfg, log);
  // Dry-run the creation as the deposit adapter (its only allowed caller) before paying the seed: a
  // refused config or signature otherwise only shows as a ComposeFailed event, with the seed parked
  // in the manager's exchange balance.
  try {
    await rpcRetry("addManagedAccount pre-check", () => p.call({ to: config.vaultProvider, from: config.depositAdapter,
      data: new ethers.Interface(["function addManagedAccount(address,bytes)"]).encodeFunctionData(
        "addManagedAccount", [manager.address, providerPayload]) }));
  } catch (e: any) {
    const d = String(e?.data ?? e?.info?.error?.data ?? "");
    let why = d ? d.slice(0, 10) : String(e?.shortMessage ?? e?.message ?? e).slice(0, 120);
    try { const x = CREATE_ERRORS.parseError(d); if (x) why = `${x.name}(${x.args.join(", ")})`; } catch {}
    throw new Error(`the provider refuses this vault configuration: ${why} — nothing sent`);
  }
  const payload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint8", "tuple(uint32,address,address,bytes,bytes)"],
    [DepositBridgeAdapterPayloadType.addManagedAccount,
     [config.lzEndpointId, config.vaultProvider, manager.address, providerPayload, "0x"]],
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
  // FIV summary words: [10] numDepositorWallets [13] depositorPendingDepositQuantity. PSV by name.
  const counts = async () => {
    if (isPsv()) { const s = await psvSummary(p, managerAddr); return { pending: s.depositorPendingDepositQuantity, n: s.numDepositorWallets }; }
    const s = await rpcRetry("loadVaultSummary", () => vp.loadVaultSummary(managerAddr));
    return { pending: Number(s[13]), n: Number(s[10]) };
  };
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
        const s = await counts();
        const bal = await vaultBalance(p, managerAddr, dep.address);
        // Applied when nothing is left pending AND this wallet's principal actually moved.
        if (s.pending === 0 && s.n >= expectDepositors && bal.costBasis > before.costBasis + 0.001) return true;
      } catch {}
      await sleep(6000);
    }
    // A deposit the dispatcher has not applied yet waits in the vault's deposit queue (the wallet's pendingDeposit
    // rose by it). Re-sending it would deposit twice once the dispatcher catches up — seen on dev during the
    // 2026-10-26 dispatcher stall. Only a deposit that went nowhere (ComposeFailed → exchange balance) is retried.
    const after = await vaultBalance(p, managerAddr, dep.address);
    if (after.pendingDeposit >= before.pendingDeposit + amountUsd - 0.06) {
      log(`  … ${dep.address} deposit of ${amountUsd} is queued but not applied yet (dispatcher lag) — not re-sending`);
      return true;
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
      // PSV: a wallet holds shares; value = shares × sharePrice. Use the SUMMARY view so
      // availableToWithdraw is NETTED by the withdrawal-limit windows (churn/decide treat it as
      // authoritative — the full position value would make churn oversize and revert).
      // [0] costBasis [2] pendingDeposit [3] sharesAvailableToWithdraw [4] sharesLocked [5] totalShares.
      const b = await rpcRetry("loadVaultBalance", () => vp.loadVaultBalanceForWalletSummary(managerAddr, wallet));
      const price = Number(await rpcRetry("loadSharePrice", () => vp.loadSharePrice(managerAddr))) / PIPS;
      return {
        costBasis: Number(b[0]) / PIPS, locked: Number(b[4]) / PIPS, owed: (Number(b[5]) / PIPS) * price,
        pendingDeposit: Number(b[2]) / PIPS, availableToWithdraw: (Number(b[3]) / PIPS) * price,
        // Same-read price + share count, so a PSV withdrawal can be sized in shares without overshooting.
        sharePrice: price, availableShares: Number(b[3]) / PIPS,
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

  if (isPsv()) {
    const s = await psvSummary(p, managerAddr, pin);
    // PSV: `owed` is replaced by VALUE = shares × sharePrice. The FIV owed==sum(perWallet) invariant
    // does not apply (share price is a single oracle-derived number), so deltaPips is 0.
    const price = Number(await rpcRetry("loadSharePrice pinned", () => vp.loadSharePrice(managerAddr, { blockTag: pin }))) / PIPS;
    const per: { address: string; owed: number; costBasis: number }[] = [];
    for (const d of depositors) {
      const b = await rpcRetry("loadVaultBalance pinned", () => vp.loadVaultBalanceForWallet(managerAddr, d, { blockTag: pin }));
      per.push({ address: d, owed: (Number(b[5]) / PIPS) * price, costBasis: Number(b[0]) / PIPS });
    }
    return {
      pin, isActive: !s.isExited && !s.isLiquidated, isExited: s.isExited, isLiquidated: s.isLiquidated,
      depositorNetDeposits: s.depositorNetDeposits / PIPS, numDepositorWallets: s.numDepositorWallets,
      totalOwed: (s.totalShares / PIPS) * price, depositorPending: s.depositorPendingDepositQuantity / PIPS, sharePrice: price,
      perDepositor: per.filter((x) => x.owed > 0 || x.costBasis > 0), deltaPips: 0,
    };
  }

  const s = await rpcRetry("loadVaultSummary pinned", () => vp.loadVaultSummary(managerAddr, { blockTag: pin }));
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
