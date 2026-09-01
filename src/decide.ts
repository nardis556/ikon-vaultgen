/**
 * decide.ts — choose what a depositor wallet should do, given the state it is actually in.
 *
 * The naive version picks deposit/withdraw by weighted coin flip and then rejects the pick if it
 * turns out to be impossible. That wastes the wallet's scheduled slot: a wallet that rolls
 * "withdraw" with $0.40 available does nothing for another 24-48h, and a vault sitting at its
 * deposit cap produces a long run of skipped deposits while activity visibly stalls.
 *
 * This decides feasibility FIRST and only ever chooses among actions that can actually succeed, so
 * a scheduled slot always produces something unless nothing at all is possible. On top of that it
 * biases the choice on two signals, which is what makes the flow look like real depositor
 * behaviour rather than a coin flip:
 *
 *   1. Vault fill      netDeposits / maximumNetDeposits. Near the cap the vault leans toward
 *                      withdrawals; near empty it leans toward deposits. The vault oscillates in a
 *                      healthy band instead of pinning at its ceiling and stalling.
 *   2. Wallet drift    each wallet has a deterministic target size. Above it the wallet leans
 *                      toward withdrawing, below it toward depositing, so no wallet drifts
 *                      monotonically to zero or to the cap.
 *
 * Sizing is clamped to what is possible UP FRONT (headroom, quantityAvailableToWithdraw) rather
 * than picked and then rejected.
 *
 * Pure and side-effect free so the behaviour can be tested without touching a chain.
 */
import type { ChurnConfig } from "./strategy.js";

export const WITHDRAWAL_MINIMUM = 1;   // protocol: vaultWithdrawalMinimum
export const DEPOSIT_MINIMUM = 1;      // protocol: vaultDepositMinimum

export interface DecisionContext {
  walletAddress: string;
  owed: number;                    // this wallet's balance in the vault (incl. interest)
  availableToWithdraw: number;     // authoritative: nets lockedQuantity AND both limit windows
  hasWithdrawCredentials: boolean; // withdrawals are authenticated REST; deposits are not
  headroomUsd: number;             // maximumNetDeposits - depositorNetDeposits
  vaultFill: number;               // depositorNetDeposits / maximumNetDeposits, in [0, 1]
  churn: ChurnConfig;
  depositRange: [number, number];  // strategy depositors.amountUsdRange
  rng?: () => number;              // injectable for deterministic tests
}

export interface Decision {
  action: "deposit" | "withdraw" | "none";
  amountUsd: number;
  reason: string;
  /** How soon to try this wallet again. "short" when blocked by something that clears on its own. */
  retry: "normal" | "short";
}

/** Deterministic per-wallet target size, so each wallet has a stable personality. */
export function walletTarget(address: string, [lo, hi]: [number, number]): number {
  let h = 2166136261;
  for (const c of address.toLowerCase()) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  h >>>= 0;
  return lo + (h / 0xffffffff) * (hi - lo);
}

export function decide(ctx: DecisionContext): Decision {
  const rng = ctx.rng ?? Math.random;
  const isDepositor = ctx.owed > 0;

  // ── 1. Feasibility, before any preference ────────────────────────────────
  const canDeposit = ctx.headroomUsd >= DEPOSIT_MINIMUM;
  const canWithdraw = isDepositor
    && ctx.hasWithdrawCredentials
    && ctx.availableToWithdraw >= WITHDRAWAL_MINIMUM;

  if (!canDeposit && !canWithdraw) {
    // Distinguish "blocked by something that clears" from "structurally cannot".
    // A limit window reopens; a missing API key does not.
    const windowBlocked = isDepositor && ctx.hasWithdrawCredentials
      && ctx.availableToWithdraw < WITHDRAWAL_MINIMUM && ctx.owed > WITHDRAWAL_MINIMUM;
    if (windowBlocked || ctx.headroomUsd > 0) {
      return { action: "none", amountUsd: 0, retry: "short",
        reason: `nothing possible right now (headroom $${ctx.headroomUsd.toFixed(2)}, `
          + `withdrawable $${ctx.availableToWithdraw.toFixed(2)} — limit window likely exhausted); retrying soon` };
    }
    return { action: "none", amountUsd: 0, retry: "normal",
      reason: isDepositor && !ctx.hasWithdrawCredentials
        ? `vault is at its deposit cap and this wallet has no API credentials to withdraw`
        : `vault is at its deposit cap and this wallet has nothing to withdraw` };
  }

  // A wallet with no balance can only join.
  if (!isDepositor) {
    const amount = clamp(round2(rng() * (ctx.depositRange[1] - ctx.depositRange[0]) + ctx.depositRange[0]),
      DEPOSIT_MINIMUM, ctx.headroomUsd);
    return { action: "deposit", amountUsd: amount, retry: "normal",
      reason: `new depositor joining with $${amount.toFixed(2)}` };
  }

  // ── 2. Bias by vault fill and wallet drift ───────────────────────────────
  // Neutral at half-full: both weights scale by 0.5, preserving the configured ratio.
  const fill = clamp(ctx.vaultFill, 0, 1);
  let wDeposit = ctx.churn.depositWeight * (1 - fill);
  let wWithdraw = ctx.churn.withdrawWeight * fill;

  const target = walletTarget(ctx.walletAddress, ctx.depositRange);
  const drift = ctx.owed / Math.max(target, 0.01);   // >1 = above target
  if (drift > 1.5) wWithdraw *= 1 + Math.min(drift - 1.5, 2);      // well above target -> lean out
  else if (drift < 0.5) wDeposit *= 1 + Math.min(0.5 - drift, 2) * 2; // well below -> lean in

  if (!canDeposit) wDeposit = 0;
  if (!canWithdraw) wWithdraw = 0;

  // ── 3. Choose among feasible options only ────────────────────────────────
  const total = wDeposit + wWithdraw;
  // Both feasible but the bias zeroed everything (fill exactly 0 or 1): fall back to whatever works.
  const action: "deposit" | "withdraw" = total <= 0
    ? (canDeposit ? "deposit" : "withdraw")
    : (rng() * total < wDeposit ? "deposit" : "withdraw");

  // ── 4. Size, clamped up front ────────────────────────────────────────────
  if (action === "deposit") {
    const [lo, hi] = ctx.churn.depositPctOfBalanceRange;
    const pct = lo + rng() * (hi - lo);
    const amount = clamp(round2(ctx.owed * (pct / 100)), DEPOSIT_MINIMUM, ctx.headroomUsd);
    return { action: "deposit", amountUsd: amount, retry: "normal",
      reason: `top up $${amount.toFixed(2)} (${pct.toFixed(0)}% of $${ctx.owed.toFixed(2)} owed; `
        + `vault ${(fill * 100).toFixed(0)}% full, wallet at ${(drift * 100).toFixed(0)}% of target)` };
  }
  const [lo, hi] = ctx.churn.withdrawPctOfBalanceRange;
  const pct = lo + rng() * (hi - lo);
  const amount = clamp(round2(ctx.owed * (pct / 100)), WITHDRAWAL_MINIMUM, ctx.availableToWithdraw);
  return { action: "withdraw", amountUsd: amount, retry: "normal",
    reason: `withdraw $${amount.toFixed(2)} (${pct.toFixed(0)}% of $${ctx.owed.toFixed(2)} owed, capped by `
      + `$${ctx.availableToWithdraw.toFixed(2)} available; vault ${(fill * 100).toFixed(0)}% full, `
      + `wallet at ${(drift * 100).toFixed(0)}% of target)` };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
