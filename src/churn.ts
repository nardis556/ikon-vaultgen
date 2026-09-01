/**
 * churn.ts — depositors deposit and withdraw over time, on their own schedules.
 *
 * A vault whose depositor set is frozen at exactly the ten wallets created on day one, each with a
 * round unchanging balance, reads as a fixture. Real vaults gain depositors, lose them, and see
 * top-ups and partial withdrawals at irregular intervals. This gives each wallet in the pool its
 * own next-action time drawn from the strategy's interval range (default 24-48h), so activity is
 * staggered rather than synchronised.
 *
 * Schedules persist to STATE_DIR so a container restart does not re-roll every wallet and produce
 * a burst of simultaneous activity — which is exactly the tell we are trying to avoid.
 *
 * TIME_SCALE compresses the clock for demos: 0.001 replays a 24h schedule in ~86 seconds. It
 * scales the *schedule*, not the protocol — interest still accrues in real time.
 *
 * Constraints respected, all of which reject the call rather than silently truncating:
 *   - withdrawalMinimum ($1)
 *   - quantityAvailableToWithdraw (already nets both withdrawal-limit windows — authoritative)
 *   - maximumNetDeposits headroom
 *   - a wallet with no vault balance can only deposit
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { ethers } from "ethers";
import { config } from "./config.js";
import type { ChurnConfig, Strategy } from "./strategy.js";
import type { Signer } from "./wallets.js";
import { buildClient } from "./client.js";
import { withdrawByQuantity } from "./withdraw.js";
import { depositTo, ensureFunded, readVault, vaultBalance } from "./vault.js";
import { decide } from "./decide.js";

export interface ChurnState { schedule: Record<string, number>; history: { t: number; wallet: string; action: string; amount: number; ok: boolean; reason?: string }[]; }

const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

function statePath(): string {
  mkdirSync(config.stateDir, { recursive: true });
  return resolve(config.stateDir, `churn-${config.strategy}-${config.instance}.json`);
}
export function loadState(): ChurnState {
  const p = statePath();
  if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} }
  return { schedule: {}, history: [] };
}
export function saveState(s: ChurnState) {
  s.history = s.history.slice(-500);   // bounded; this runs for days
  writeFileSync(statePath(), JSON.stringify(s, null, 2));
}

/** Stagger first actions across the whole interval so day one is not a thundering herd. */
export function seedSchedule(state: ChurnState, pool: Signer[], churn: ChurnConfig, now = Date.now()) {
  const [lo, hi] = churn.intervalHoursRange;
  for (const w of pool) {
    if (state.schedule[w.address] == null) {
      state.schedule[w.address] = now + rnd(0, hi) * 3600_000 * config.timeScale;
    }
  }
  return state;
}

/**
 * @param mode "short" for a wallet blocked by something that clears on its own (an exhausted
 *             withdrawal-limit window, temporarily no deposit headroom). Burning the full 24-48h
 *             interval on those would leave the wallet idle for days over a transient condition.
 */
function reschedule(state: ChurnState, addr: string, churn: ChurnConfig,
                    now = Date.now(), mode: "normal" | "short" = "normal") {
  const [lo, hi] = churn.intervalHoursRange;
  const hours = mode === "short" ? rnd(lo, hi) / 8 : rnd(lo, hi);
  state.schedule[addr] = now + hours * 3600_000 * config.timeScale;
}

/**
 * Run one churn tick: act for every wallet whose scheduled time has arrived.
 * Returns a list of what happened, for logging.
 */
export async function churnTick(
  p: ethers.JsonRpcProvider, strategy: Strategy, managerAddr: string, pool: Signer[],
  state: ChurnState, log: (m: string) => void, dryRun: boolean,
): Promise<number> {
  const churn = strategy.churn;
  const now = Date.now();
  const due = pool.filter((w) => (state.schedule[w.address] ?? Infinity) <= now);
  if (!due.length) return 0;

  const vaultState = await readVault(p, managerAddr, pool.map((w) => w.address));
  let headroom = strategy.vault.maximumNetDeposits - vaultState.depositorNetDeposits;
  let acted = 0;

  for (const w of due) {
    const bal = await vaultBalance(p, managerAddr, w.address);

    // Decide from actual state: feasibility first, then bias by vault fill and wallet drift.
    // The decision never picks something that cannot succeed, so a scheduled slot is not wasted.
    const d = decide({
      walletAddress: w.address,
      owed: bal.owed,
      availableToWithdraw: bal.availableToWithdraw,
      hasWithdrawCredentials: Boolean(w.apiKey && w.apiSecret),
      headroomUsd: headroom,
      vaultFill: strategy.vault.maximumNetDeposits > 0
        ? vaultState.depositorNetDeposits / strategy.vault.maximumNetDeposits : 0,
      churn,
      depositRange: strategy.depositors.amountUsdRange,
    });

    if (d.action === "none") {
      log(`    – ${w.name}: ${d.reason}`);
      reschedule(state, w.address, churn, now, d.retry);
      continue;
    }

    const isJoin = bal.owed <= 0;
    try {
      if (d.action === "deposit") {
        if (dryRun) {
          log(`    · ${w.name} would ${isJoin ? "JOIN" : "top up"}: ${d.reason}`);
        } else {
          await ensureFunded(p, w.address, config.depEth, String(d.amountUsd + 5));
          const ok = await depositTo(p, {
            managerAddr, dep: new ethers.Wallet(w.privateKey, p), amountUsd: d.amountUsd,
            expectDepositors: vaultState.numDepositorWallets + (isJoin ? 1 : 0),
            settleMs: config.settleMs, attempts: 2, log,
          });
          state.history.push({ t: now, wallet: w.address, action: isJoin ? "join" : "top-up",
                               amount: d.amountUsd, ok });
          log(`    ${ok ? "✓" : "✗"} ${w.name} ${isJoin ? "JOIN" : "top-up"} — ${d.reason}`);
          if (ok) { headroom -= d.amountUsd; acted++; }
        }
      } else {
        if (dryRun) {
          log(`    · ${w.name} would withdraw: ${d.reason}`);
        } else {
          const c = buildClient(w.apiKey!, w.apiSecret!, w.privateKey);
          await withdrawByQuantity(c, managerAddr, d.amountUsd);
          state.history.push({ t: now, wallet: w.address, action: "withdraw", amount: d.amountUsd, ok: true });
          log(`    ✓ ${w.name} withdraw enqueued — ${d.reason}`);
          acted++;
        }
      }
    } catch (e: any) {
      const reason = String(e?.message ?? e).slice(0, 120);
      state.history.push({ t: now, wallet: w.address, action: d.action, amount: d.amountUsd, ok: false, reason });
      log(`    ✗ ${w.name} ${d.action}: ${reason}`);
    }
    reschedule(state, w.address, churn, now);
  }
  return acted;
}
