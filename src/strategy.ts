/**
 * strategy.ts — declarative vault strategy: on-chain config, presentation metadata, and the two
 * activity behaviours (depositor churn, market making) in ONE file.
 *
 * Why one file: a vault's identity (the name and description a market maker reads) and its
 * economics (exit threshold, collateralization) have to agree. Splitting them across env files is
 * how you end up demoing a vault called "Conservative Income" whose parameters say otherwise.
 *
 * Every numeric field is validated against bounds ENFORCED ON-CHAIN. Busting one does not throw a
 * clean error: `addManagedAccount` reverts INSIDE the compose call, the adapter re-credits the seed
 * to the manager's exchange balance, and you get a ComposeFailed event instead of a vault.
 * Validating here turns that into a startup error naming the field.
 */
import { readFileSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STRATEGY_DIR = resolve(__dirname, "../strategies");

// From the SDK's RestRequestSetVaultDetails.
export const VAULT_NAME_CHARACTER_LIMIT = 30;
export const VAULT_DESCRIPTION_CHARACTER_LIMIT = 2000;

// Protocol economics the strategies were authored against; provision.ts re-reads the live values
// from GET /exchange and fails loudly on drift rather than trusting these.
export const EXPECTED_CREATION_MINIMUM = 100;
export const EXPECTED_CREATION_FEE = 10;
export const EXPECTED_DEPOSIT_FEE = 0.05;
export const EXPECTED_WITHDRAWAL_MINIMUM = 1;

const BOUNDS = {
  interestApyPct:               { min: 0,    max: 1000 },
  maximumNetDeposits:           { min: 100,  max: 1e12 },      // MIN_MAXIMUM_NET_DEPOSITS = $100
  exitMultiplier:               { min: 0.50, max: 2.00 },      // both enforced
  managerWithdrawMultiplier:    { min: 0.50, max: 9.99 },      // both enforced (1e9 pips reverts)
  unappliedAgeS:                { min: 3600, max: 2_419_200 }, // 1h .. 28d, both enforced
  withdrawalLimitPctDepositors: { min: 10,   max: 100 },       // both enforced
  withdrawalLimitPctVault:      { min: 0,    max: 100 },
} as const;

export interface ChurnConfig {
  enabled: boolean;
  intervalHoursRange: [number, number];
  depositPctOfBalanceRange: [number, number];
  withdrawPctOfBalanceRange: [number, number];
  depositWeight: number;
  withdrawWeight: number;
}
export interface MarketMakingConfig {
  enabled: boolean;
  markets: string[];
  ordersPerSide: number;
  priceRangePct: number;
  skewStrength: number;
  maxPositionUsd: number;
  refreshSeconds: number;
  quoteNotionalUsd: number;
}
export interface Strategy {
  id: string;
  profile: string;
  display: { name: string; description: string; x?: string | null };
  vault: Record<string, number>;
  seed: { managerSeedUsd: number };
  depositors: { count: number; amountUsdRange: [number, number] };
  churn: ChurnConfig;
  marketMaking: MarketMakingConfig;
}

export function listStrategies(): { id: string; name: string; profile: string }[] {
  return readdirSync(STRATEGY_DIR).filter((f) => f.endsWith(".json")).sort()
    .map((f) => {
      const s = JSON.parse(readFileSync(resolve(STRATEGY_DIR, f), "utf8"));
      return { id: s.id, name: s.display.name, profile: s.profile };
    });
}

export function loadStrategy(id: string): Strategy {
  for (const f of readdirSync(STRATEGY_DIR).filter((x) => x.endsWith(".json")).sort()) {
    const s = JSON.parse(readFileSync(resolve(STRATEGY_DIR, f), "utf8")) as Strategy;
    if (s.id === id) return s;
  }
  throw new Error(`Unknown STRATEGY "${id}". Available: ${listStrategies().map((s) => s.id).join(", ")}`);
}

/** Throws on anything the chain would reject; returns non-fatal warnings. */
export function validateStrategy(s: Strategy): string[] {
  const errs: string[] = [];
  const warns: string[] = [];

  if (!s.id) errs.push("id is required");
  if (!s.display?.name) errs.push("display.name is required");
  else if (s.display.name.length > VAULT_NAME_CHARACTER_LIMIT)
    errs.push(`display.name is ${s.display.name.length} chars — max ${VAULT_NAME_CHARACTER_LIMIT}`);
  if (!s.display?.description) errs.push("display.description is required");
  else if (s.display.description.length > VAULT_DESCRIPTION_CHARACTER_LIMIT)
    errs.push(`display.description is ${s.display.description.length} chars — max ${VAULT_DESCRIPTION_CHARACTER_LIMIT}`);

  for (const [k, b] of Object.entries(BOUNDS)) {
    const v = s.vault?.[k];
    if (typeof v !== "number" || Number.isNaN(v)) { errs.push(`vault.${k} must be a number`); continue; }
    if (v < b.min || v > b.max) errs.push(`vault.${k}=${v} is outside the on-chain bound [${b.min}, ${b.max}]`);
  }

  const floor = EXPECTED_CREATION_MINIMUM + EXPECTED_CREATION_FEE;
  if (s.seed?.managerSeedUsd == null) errs.push("seed.managerSeedUsd is required");
  else if (s.seed.managerSeedUsd < floor)
    errs.push(`seed.managerSeedUsd=${s.seed.managerSeedUsd} is below the ${floor} floor `
      + `(creationMinimum ${EXPECTED_CREATION_MINIMUM} + creationFee ${EXPECTED_CREATION_FEE}); creation would `
      + `ComposeFail and the seed would land in the manager's exchange balance`);

  const [lo, hi] = s.depositors?.amountUsdRange ?? [0, 0];
  if (!s.depositors?.count || s.depositors.count < 1) errs.push("depositors.count must be >= 1");
  if (s.depositors?.count > 100) errs.push("depositors.count > 100 exceeds the per-vault deposit queue cap");
  if (lo <= 0 || hi < lo) errs.push(`depositors.amountUsdRange [${lo}, ${hi}] is invalid`);
  if (lo <= EXPECTED_DEPOSIT_FEE)
    errs.push(`depositors.amountUsdRange low end ${lo} must exceed the ${EXPECTED_DEPOSIT_FEE} deposit fee`);
  const maxTotal = hi * (s.depositors?.count ?? 0);
  if (maxTotal > s.vault?.maximumNetDeposits)
    errs.push(`worst-case depositor total ${maxTotal} exceeds vault.maximumNetDeposits `
      + `${s.vault.maximumNetDeposits} — the last deposits would be rejected`);

  // ── Churn ─────────────────────────────────────────────────────────────────
  if (s.churn?.enabled) {
    const [clo, chi] = s.churn.intervalHoursRange ?? [0, 0];
    if (clo <= 0 || chi < clo) errs.push(`churn.intervalHoursRange [${clo}, ${chi}] is invalid`);
    if (!(s.churn.depositWeight + s.churn.withdrawWeight > 0)) errs.push("churn weights must sum > 0");
    // Headroom: churn deposits must not push the vault past its own cap.
    if (maxTotal > s.vault?.maximumNetDeposits * 0.9)
      warns.push(`churn has little headroom — initial deposits (${maxTotal}) are already >90% of `
        + `maximumNetDeposits (${s.vault.maximumNetDeposits}); top-up deposits will start bouncing`);
    // A queued withdrawal that outlives unappliedAgeS makes the vault exit-eligible to ANYONE.
    // Healthy dispatchers drain in seconds, so this is a "if the backend stalls" note, not a bug.
    warns.push(`churn queues real withdrawals; if the withdrawal dispatcher stalls for more than `
      + `vault.unappliedAgeS (${s.vault.unappliedAgeS}s) the queue-age trigger makes this vault `
      + `exit-eligible to any depositor. Expected behaviour — just do not leave it stalled mid-demo.`);
  }

  // ── Market making ─────────────────────────────────────────────────────────
  if (s.marketMaking?.enabled) {
    if (!s.marketMaking.markets?.length) errs.push("marketMaking.markets must be non-empty when enabled");
    if (!(s.marketMaking.ordersPerSide >= 1)) errs.push("marketMaking.ordersPerSide must be >= 1");
    if (!(s.marketMaking.priceRangePct > 0 && s.marketMaking.priceRangePct < 0.5))
      errs.push(`marketMaking.priceRangePct ${s.marketMaking.priceRangePct} must be in (0, 0.5)`);
    if (!(s.marketMaking.skewStrength >= 0 && s.marketMaking.skewStrength <= 1))
      errs.push(`marketMaking.skewStrength ${s.marketMaking.skewStrength} must be in [0, 1]`);
    // At skew 1.0 the reducing side is quoted AT index (offset x 0) — it becomes an effective
    // taker and pays the spread on every fill. Legal, but it is no longer market making.
    if (s.marketMaking.skewStrength > 0.9)
      warns.push(`marketMaking.skewStrength ${s.marketMaking.skewStrength} is very high — at full skew the `
        + `reducing side quotes essentially at index and will cross rather than earn spread`);
    if (!(s.marketMaking.maxPositionUsd > 0)) errs.push("marketMaking.maxPositionUsd must be > 0");
    // Manager quotes are collateralised by the manager's own seed, not depositor principal.
    if (s.marketMaking.maxPositionUsd > s.seed?.managerSeedUsd * 6)
      warns.push(`marketMaking.maxPositionUsd ${s.marketMaking.maxPositionUsd} is >6x the manager seed `
        + `${s.seed.managerSeedUsd} — that is high leverage on the first-loss buffer; a bad run could `
        + `liquidate the vault mid-demo`);
  }

  // ── Parameter-deadlock band ───────────────────────────────────────────────
  // Exit needs EAV < exitMult x owed; manager withdrawal needs EAV >= mgrWdMult x owed. When
  // mgrWdMult > exitMult there is a band of EAV where NEITHER is possible. Legal on-chain, a real
  // finding in the Foundry suite — and a terrible thing to demo.
  if (s.vault?.managerWithdrawMultiplier > s.vault?.exitMultiplier) {
    warns.push(`DEADLOCK BAND: managerWithdrawMultiplier ${s.vault.managerWithdrawMultiplier}x > `
      + `exitMultiplier ${s.vault.exitMultiplier}x. For EAV/owed between those values neither exit nor `
      + `manager-withdraw is possible. Set managerWithdrawMultiplier <= exitMultiplier unless deliberate.`);
  }

  // ── Exit reachability, given how this vault is capitalised ────────────────
  if (s.vault && s.seed && s.depositors) {
    const seedNet = s.seed.managerSeedUsd - EXPECTED_CREATION_FEE;
    const owedMid = ((lo + hi) / 2) * s.depositors.count;
    if (s.vault.exitMultiplier <= 1) {
      warns.push(`exitMultiplier ${s.vault.exitMultiplier}x <= 1.0 — the EAV exit trigger can NEVER fire while `
        + `solvent. Depositors' only route is the ${s.vault.unappliedAgeS}s queue-age trigger. Deliberate here.`);
    } else if (seedNet >= (s.vault.exitMultiplier - 1) * owedMid) {
      warns.push(`Not exit-eligible at the planned size: seedNet ${seedNet.toFixed(0)} needs depositor owed > `
        + `${(seedNet / (s.vault.exitMultiplier - 1)).toFixed(0)} for the EAV trigger, planned owed is ~`
        + `${owedMid.toFixed(0)}. Over-collateralized and healthy — expected for this profile.`);
    }
  }

  if (errs.length) throw new Error(`Strategy "${s.id}" is invalid:\n  - ${errs.join("\n  - ")}`);
  return warns;
}

/** Human values -> integer fields for encodeFixedIncomeVaultConfigurationFields. */
export function toChainFields(s: Strategy, decimalToPip: (v: string) => any): Record<string, any> {
  return {
    interestMultiplierInPips: decimalToPip((s.vault.interestApyPct / 100).toFixed(4)),
    maximumNetDepositsInPips: decimalToPip(String(s.vault.maximumNetDeposits)),
    maximumTotalOwedQuantityAvailableForExitWithdrawalMultiplierNeededToInitiateExitInPips:
      decimalToPip(s.vault.exitMultiplier.toFixed(2)),
    minimumTotalOwedQuantityAvailableForExitWithdrawalMultiplierToAllowManagerWalletWithdrawalInPips:
      decimalToPip(s.vault.managerWithdrawMultiplier.toFixed(2)),
    minimumUnappliedWithdrawalAgeInSNeededToInitiateExit: s.vault.unappliedAgeS,
    withdrawalLimitPercentForDepositorsInPips: decimalToPip((s.vault.withdrawalLimitPctDepositors / 100).toFixed(2)),
    withdrawalLimitPercentForVaultInPips: decimalToPip((s.vault.withdrawalLimitPctVault / 100).toFixed(2)),
  };
}
