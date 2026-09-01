/**
 * mm.ts — inventory-skewed market making for a vault manager.
 *
 * The loadgen quotes a SYMMETRIC ladder around index and merely *gates* a side once the position
 * gets large (POSITION_STOP_FACTOR). That keeps position bounded but does nothing to actively
 * unwind it: the book just stops growing on one side and sits there.
 *
 * This quotes ASYMMETRICALLY instead. Inventory ratio r = net / maxPosition, in [-1, 1]:
 *
 *   reducing side  (sell when long, buy when short)  offset x (1 - k|r|)   -> pulled TOWARD index
 *   adding   side  (buy  when long, sell when short) offset x (1 + k|r|)   -> pushed AWAY from index
 *
 * so the side that flattens the book is closer to index and therefore likelier to fill, while the
 * side that would add to it retreats. k = skewStrength. A flat book (r = 0) quotes symmetrically;
 * a book at the position limit (|r| = 1) quotes hard on one side only. The result is a book that
 * walks itself back to flat rather than accumulating, which is what a real desk does.
 *
 * Size is skewed mildly too — the adding side quotes smaller — so an adverse fill on the far side
 * moves inventory less than the near-side fill that corrects it.
 *
 * Quotes are post-only (gtx). A maker that crosses is not earning spread, it is paying it; without
 * gtx an aggressively skewed near-side quote would sometimes take.
 */
import * as kperps from "@katanaperps/katana-perps-sdk";
import BigNumber from "bignumber.js";
import type { Client } from "./client.js";
import type { MarketMakingConfig } from "./strategy.js";

export interface MarketInfo { market: string; indexPrice: number; tickSize: string; takerOrderMinimum: number; }

/** Snap to the tick grid, away from mid so a maker quote never becomes a crossing one. */
function snap(value: number, tickSize: string, side: "buy" | "sell"): string {
  const tick = new BigNumber(tickSize);
  const mode = side === "buy" ? BigNumber.ROUND_DOWN : BigNumber.ROUND_UP;
  return new BigNumber(value).dividedBy(tick).integerValue(mode).multipliedBy(tick).toFixed();
}

export interface Quote { market: string; side: "buy" | "sell"; price: string; quantity: string; }

/**
 * Build one market's two-sided, inventory-skewed ladder.
 *
 * @param netPosition signed position in BASE units (negative = short)
 */
export function buildSkewedQuotes(
  m: MarketInfo, cfg: MarketMakingConfig, netPosition: number,
): { quotes: Quote[]; r: number; note: string } {
  const maxQty = cfg.maxPositionUsd / m.indexPrice;
  // r: how far inventory sits from the limit. Clamped so a position that overshot the cap
  // (possible after a fill) still yields a valid, fully-skewed quote set rather than NaN.
  const r = Math.max(-1, Math.min(1, maxQty > 0 ? netPosition / maxQty : 0));
  const k = cfg.skewStrength;
  const long = r > 0;

  // Multipliers per side. |r| = 0 -> both 1.0 (symmetric).
  const reducingMult = 1 - k * Math.abs(r);
  const addingMult = 1 + k * Math.abs(r);
  const buyMult = long ? addingMult : reducingMult;
  const sellMult = long ? reducingMult : addingMult;
  // Same idea for size: the adding side quotes smaller.
  const buySizeMult = long ? 1 - 0.5 * k * Math.abs(r) : 1;
  const sellSizeMult = long ? 1 : 1 - 0.5 * k * Math.abs(r);

  const step = (m.indexPrice * cfg.priceRangePct) / cfg.ordersPerSide;
  const baseQty = Math.max(m.takerOrderMinimum, cfg.quoteNotionalUsd / m.indexPrice);
  const quotes: Quote[] = [];

  for (const side of ["buy", "sell"] as const) {
    const mult = side === "buy" ? buyMult : sellMult;
    const sizeMult = side === "buy" ? buySizeMult : sellSizeMult;
    // A fully-skewed reducing side (k=1, |r|=1) would collapse to offset 0 = quoting AT index,
    // which gtx would simply reject. Keep at least one tick of separation.
    const minOff = Number(m.tickSize);
    for (let i = 0; i < cfg.ordersPerSide; i++) {
      const off = Math.max(minOff, step * (i + 1) * mult);
      const raw = side === "buy" ? m.indexPrice - off : m.indexPrice + off;
      const price = snap(raw, m.tickSize, side);
      // Never quote through index — that is a taker in maker's clothing.
      if (side === "buy" && Number(price) >= m.indexPrice) continue;
      if (side === "sell" && Number(price) <= m.indexPrice) continue;
      const qty = Math.max(m.takerOrderMinimum, baseQty * sizeMult * (1 - i * 0.05));
      quotes.push({ market: m.market, side, price, quantity: qty.toFixed(8) });
    }
  }

  const note = `net=${netPosition.toFixed(6)} r=${r.toFixed(3)} `
    + `${long ? "LONG" : r < 0 ? "SHORT" : "flat"} → buyOffset x${buyMult.toFixed(2)} sellOffset x${sellMult.toFixed(2)}`;
  return { quotes, r, note };
}

/** Net signed base position per market for a wallet, from one getWallets call. */
export async function fetchNetPositions(client: Client): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const wallets: any = await (client.auth as any).getWallets({ nonce: client.nonce(), wallet: client.wallet });
    const w = (Array.isArray(wallets) ? wallets : [wallets]).find((x: any) =>
      x?.wallet?.toLowerCase?.() === client.wallet.toLowerCase()) ?? (Array.isArray(wallets) ? wallets[0] : wallets);
    for (const p of (w?.positions ?? []) as any[]) out[p.market] = Number(p.quantity ?? 0);
  } catch (e: any) {
    throw new Error(`getWallets failed (needs valid manager API credentials): ${e?.message ?? e}`);
  }
  return out;
}

/** Replace this market's quotes: cancel, then place the freshly skewed ladder. */
export async function requoteMarket(
  client: Client, m: MarketInfo, cfg: MarketMakingConfig, netPosition: number,
  log: (msg: string) => void, dryRun: boolean,
): Promise<number> {
  const { quotes, note } = buildSkewedQuotes(m, cfg, netPosition);
  log(`    ${m.market.padEnd(9)} idx=${m.indexPrice}  ${note}  quotes=${quotes.length}`);
  if (dryRun) {
    for (const q of quotes.slice(0, 4)) log(`      ${q.side.padEnd(4)} ${q.price} x ${q.quantity}`);
    if (quotes.length > 4) log(`      … +${quotes.length - 4} more`);
    return 0;
  }
  await (client.auth as any).cancelOrders({ nonce: client.nonce(), wallet: client.wallet, market: m.market });
  let placed = 0;
  for (const q of quotes) {
    try {
      await (client.auth as any).createOrder({
        nonce: client.nonce(), wallet: client.wallet, market: q.market,
        side: q.side === "buy" ? kperps.OrderSide.buy : kperps.OrderSide.sell,
        type: kperps.OrderType.limit,
        timeInForce: kperps.TimeInForce.gtx,   // post-only: never cross
        quantity: q.quantity, price: q.price,
      });
      placed++;
    } catch (e: any) {
      log(`      ! ${q.side} ${q.price}: ${String(e?.message ?? e).slice(0, 90)}`);
    }
  }
  return placed;
}
