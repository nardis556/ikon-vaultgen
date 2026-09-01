/**
 * animate.ts — the daemon: keeps a provisioned vault looking alive.
 *
 * Two independent behaviours on one loop:
 *   - churn: depositors join / top up / withdraw on their own multi-day schedules
 *   - market making: the manager quotes an inventory-skewed two-sided book
 *
 * Either can be disabled per strategy (or via CHURN_ENABLED / MM_ENABLED). DRY-RUN unless
 * EXECUTE=1, and the dry run prints the exact quotes and churn actions it would take.
 */
import { ethers } from "ethers";
import { config } from "./config.js";
import { loadStrategy, validateStrategy } from "./strategy.js";
import { loadManager, loadDepositorPool } from "./wallets.js";
import { provider, readVault, sleep } from "./vault.js";
import { buildClient } from "./client.js";
import { fetchNetPositions, requoteMarket, openSeedPositions, type MarketInfo } from "./mm.js";
import { churnTick, loadState, saveState, seedSchedule } from "./churn.js";

const log = (m = "") => console.log(m);
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

async function fetchMarkets(want: string[]): Promise<MarketInfo[]> {
  const res = await fetch(`${config.baseUrl}/markets`, { headers: { "User-Agent": "ikon-vaultgen" } });
  if (!res.ok) throw new Error(`GET /markets failed: HTTP ${res.status}`);
  const all: any[] = await res.json();
  const out: MarketInfo[] = [];
  for (const m of want) {
    const hit = all.find((x) => x.market === m);
    if (!hit) { log(`  ! market ${m} not listed on this exchange — skipping`); continue; }
    out.push({
      market: hit.market, indexPrice: Number(hit.indexPrice),
      tickSize: hit.tickSize, takerOrderMinimum: Number(hit.takerOrderMinimum),
      stepSize: hit.stepSize, minimumPositionSize: Number(hit.minimumPositionSize ?? 0),
    });
  }
  return out;
}

export async function animate() {
  const strategy = loadStrategy(config.strategy);
  const warns = validateStrategy(strategy);
  const churnOn = config.churnEnabled ?? strategy.churn.enabled;
  const mmOn = config.mmEnabled ?? strategy.marketMaking.enabled;

  log("=".repeat(74));
  log(`  ikon-vaultgen animate — ${strategy.display.name} [${strategy.id}] instance ${config.instance}`);
  log("=".repeat(74));
  log(`  churn        : ${churnOn ? `on, every ${strategy.churn.intervalHoursRange.join("-")}h per wallet` : "off"}`);
  log(`  market making: ${mmOn ? `on, ${strategy.marketMaking.markets.join(", ")} `
      + `skew=${strategy.marketMaking.skewStrength} maxPos=$${strategy.marketMaking.maxPositionUsd}` : "off"}`);
  log(`  time scale   : ${config.timeScale}x${config.timeScale !== 1 ? "  (schedule compressed; interest still real-time)" : ""}`);
  log(`  mode         : ${config.execute ? "LIVE" : "DRY-RUN — nothing will be sent"}`);
  for (const w of warns) log(`  ⚠ ${w}`);

  const { signer: mgr } = loadManager(false);
  const poolSize = config.depositorPoolSize || strategy.depositors.count;
  const { pool } = loadDepositorPool(poolSize, false);
  log(`\n  manager      : ${mgr.address}`);
  log(`  pool         : ${pool.length} depositor wallets`);

  const p = provider();
  const state = seedSchedule(loadState(), pool, strategy.churn);
  saveState(state);

  let mmClient: ReturnType<typeof buildClient> | null = null;
  if (mmOn) {
    if (!mgr.apiKey || !mgr.apiSecret) {
      log(`\n  ! market making needs manager API credentials in .env.MANAGER (fields 3 and 4). Disabling MM.`);
    } else {
      mmClient = buildClient(mgr.apiKey, mgr.apiSecret, mgr.privateKey);
    }
  }

  let lastMm = 0;
  let seeded = false;
  for (;;) {
    const now = Date.now();
    try {
      let v;
      try {
        v = await readVault(p, mgr.address, pool.map((w) => w.address));
      } catch (e: any) {
        // 0xe64a6a36 is the provider's "no vault for this manager wallet" revert. It is the
        // normal state before provisioning, so say that instead of dumping calldata.
        const d = String(e?.data ?? e?.info?.error?.data ?? "");
        if (d.startsWith("0xe64a6a36")) {
          log(`\n  No vault exists for manager ${mgr.address}.`);
          log(`  Run MODE=provision (EXECUTE=1) for this strategy first, then start the daemon.`);
          return;
        }
        throw e;
      }
      log(`\n[${ts()}] depositors=${v.numDepositorWallets} owed=$${v.totalOwed.toFixed(2)} `
        + `pending=$${v.depositorPending.toFixed(2)}${v.isExited ? " EXITED" : ""}${v.isLiquidated ? " LIQUIDATED" : ""}`);
      if (v.isLiquidated || v.isExited) {
        log(`  vault is ${v.isLiquidated ? "liquidated" : "exited"} — stopping the daemon; nothing further is meaningful.`);
        return;
      }

      if (mmOn && mmClient && now - lastMm >= strategy.marketMaking.refreshSeconds * 1000) {
        lastMm = now;
        const markets = await fetchMarkets(strategy.marketMaking.markets);
        let positions: Record<string, number> = {};
        try { positions = await fetchNetPositions(mmClient); }
        catch (e: any) { log(`  ! ${e?.message ?? e}`); }
        // Seed real inventory once, so the vault visibly holds positions instead of only
        // resting post-only quotes that may never be crossed on a quiet market.
        if (!seeded && config.seedPositions > 0) {
          const held = Object.keys(positions).filter((k) => positions[k] !== 0).length;
          if (held < config.seedPositions) {
            log(`  seeding positions (holding ${held}, want ${config.seedPositions}):`);
            await openSeedPositions(mmClient, markets, strategy.marketMaking,
              config.seedPositions - held, positions, log, !config.execute);
            if (config.execute) {
              await sleep(4000);
              try { positions = await fetchNetPositions(mmClient); } catch {}
            }
          }
          seeded = true;
        }

        log(`  market making:`);
        for (const m of markets) {
          await requoteMarket(mmClient, m, strategy.marketMaking, positions[m.market] ?? 0, log, !config.execute);
        }
      }

      // Churn AFTER market making. At a compressed TIME_SCALE every wallet comes due at
      // once and each action carries a settle delay, so churn-first would starve the
      // market maker and the vault would never open a position.
      if (churnOn) {
        const n = await churnTick(p, strategy, mgr.address, pool, state, log, !config.execute);
        if (n) saveState(state);
      }

    } catch (e: any) {
      log(`  ! tick error: ${String(e?.message ?? e).slice(0, 160)}`);
    }

    if (!config.execute && process.env.ONESHOT === "1") {
      log(`\n  DRY-RUN one-shot complete (ONESHOT=1). Nothing sent.`);
      return;
    }
    await sleep(config.tickSeconds * 1000);
  }
}
