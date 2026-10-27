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
 *
 * The ladder is centred on index, but the book may not be: on dev the resting orders of a stopped
 * loadgen sat ~3.5% below index for days. Every bid then crossed those asks and gtx cancelled it,
 * so the vault quoted one side only and never traded. A quote that would cross the opposite best
 * is therefore moved to one tick inside it (levels stay a tick apart) instead of being thrown away.
 */
import * as kperps from "@katanaperps/katana-perps-sdk";
import BigNumber from "bignumber.js";
import type { Client } from "./client.js";
import type { MarketMakingConfig } from "./strategy.js";

export interface MarketInfo {
  market: string; indexPrice: number; tickSize: string;
  takerOrderMinimum: number; stepSize: string; minimumPositionSize?: number;
  /** RWA markets (XAU, XAG, WTI) close daily and at weekends: "open" | "closed" | "preOpen" | … */
  tradingSessionStatus?: string;
  approximateNextOpenTime?: number;
}

/** Snap to the tick grid, away from mid so a maker quote never becomes a crossing one. */
function snap(value: number, tickSize: string, side: "buy" | "sell"): string {
  const tick = new BigNumber(tickSize);
  const mode = side === "buy" ? BigNumber.ROUND_DOWN : BigNumber.ROUND_UP;
  // Fixed 8 decimals, like quantity. Loose formatting ("100.3" rather than "100.30000000")
  // is rejected with a bare HTTP 400 — every ladder order failed this way while the
  // identical price sent as 8dp was accepted.
  return new BigNumber(value).dividedBy(tick).integerValue(mode).multipliedBy(tick).toFixed(8);
}

export interface Quote { market: string; side: "buy" | "sell"; price: string; quantity: string; }
/** Best bid / ask of the OTHER resting orders (read after cancelling our own). */
export interface BookTop { bid?: number; ask?: number; }

/**
 * Build one market's two-sided, inventory-skewed ladder.
 *
 * @param netPosition signed position in BASE units (negative = short)
 */
export function buildSkewedQuotes(
  m: MarketInfo, cfg: MarketMakingConfig, netPosition: number, book: BookTop = {},
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
  const tick = Number(m.tickSize);
  let clamped = 0;

  for (const side of ["buy", "sell"] as const) {
    const mult = side === "buy" ? buyMult : sellMult;
    const sizeMult = side === "buy" ? buySizeMult : sellSizeMult;
    // A fully-skewed reducing side (k=1, |r|=1) would collapse to offset 0 = quoting AT index,
    // which gtx would simply reject. Keep at least one tick of separation.
    const minOff = tick;
    // The tightest price this side may use without crossing the book; it moves a tick further out
    // after every level so clamped levels stay distinct.
    let bound = side === "buy" ? (book.ask ?? Infinity) - tick : (book.bid ?? -Infinity) + tick;
    for (let i = 0; i < cfg.ordersPerSide; i++) {
      const off = Math.max(minOff, step * (i + 1) * mult);
      const raw = side === "buy" ? m.indexPrice - off : m.indexPrice + off;
      let price = snap(raw, m.tickSize, side);
      if (side === "buy" ? Number(price) > bound : Number(price) < bound) { price = snap(bound, m.tickSize, side); clamped++; }
      if (Number(price) <= 0) continue;
      bound = side === "buy" ? Number(price) - tick : Number(price) + tick;
      // Never quote through index — that is a taker in maker's clothing.
      if (side === "buy" && Number(price) >= m.indexPrice) continue;
      if (side === "sell" && Number(price) <= m.indexPrice) continue;
      const qty = Math.max(m.takerOrderMinimum, baseQty * sizeMult * (1 - i * 0.05));
      quotes.push({ market: m.market, side, price, quantity: snapQty(qty, m.stepSize, m.takerOrderMinimum) });
    }
  }

  const note = `net=${netPosition.toFixed(6)} r=${r.toFixed(3)} `
    + `${long ? "LONG" : r < 0 ? "SHORT" : "flat"} → buyOffset x${buyMult.toFixed(2)} sellOffset x${sellMult.toFixed(2)}`
    + (clamped ? `  (${clamped} held inside the book: bid ${book.bid ?? "-"} / ask ${book.ask ?? "-"})` : "");
  return { quotes, r, note };
}

/** Snap a quantity DOWN to the market's step grid, never below the taker minimum. */
function snapQty(qty: number, stepSize: string, takerMin: number): string {
  const step = new BigNumber(stepSize);
  let q = new BigNumber(qty).dividedBy(step).integerValue(BigNumber.ROUND_DOWN).multipliedBy(step);
  if (q.isLessThan(takerMin)) {
    q = new BigNumber(takerMin).dividedBy(step).integerValue(BigNumber.ROUND_UP).multipliedBy(step);
  }
  // The API rejects loose decimal formatting ("Invalid quantity value") — send a fixed
  // 8-decimal string, the same precision prices use.
  return q.toFixed(8);
}

/**
 * Open seed positions so the vault is visibly running a book.
 *
 * The resting ladder is post-only, so it produces a position only when somebody else crosses it
 * — on a quiet market that may be never, and a demo vault showing zero positions looks dead. This
 * takes liquidity deliberately with small market orders, on distinct markets, so each manager ends
 * up holding real inventory.
 *
 * It also makes the inventory skew observable, which is the point of the strategy: a flat book
 * quotes symmetrically, so with no position there is nothing to see. Once inventory exists the
 * reducing side visibly tightens toward index.
 *
 * Sized off quoteNotionalUsd rather than the position cap, so seeding never approaches
 * maxPositionUsd and leaves the skew room to work in both directions.
 */
export async function openSeedPositions(
  client: Client, markets: MarketInfo[], cfg: MarketMakingConfig,
  want: number, existing: Record<string, number>,
  bias: Record<string, number>,
  log: (m: string) => void, dryRun: boolean,
): Promise<number> {
  // Only markets we are not already in — one position per market keeps the skew per-market clean.
  const candidates = markets.filter((m) => !existing[m.market]);
  const targets = candidates.slice(0, Math.max(0, want));
  if (!targets.length) { log(`    already holding ${Object.keys(existing).length} position(s) — no seeding needed`); return 0; }

  let opened = 0;
  for (const m of targets) {
    const notional = cfg.quoteNotionalUsd;
    const qty = snapQty(notional / m.indexPrice, m.stepSize, m.takerOrderMinimum);
    // Direction comes from the strategy's rule. A bias of 0 means the rule has no setup
    // right now (RSI mid-range, price inside the channel or the bands) — in that case we
    // open nothing and just keep quoting, which is what the strategy actually says it does.
    const b = bias[m.market] ?? 0;
    if (b === 0) { log(`    – ${m.market}: no setup, holding no position (still quoting)`); continue; }
    const side = b > 0 ? "buy" : "sell";
    if (dryRun) {
      log(`    · would ${side} ${qty} ${m.market} (~$${notional}) at market`);
      opened++; continue;
    }
    try {
      await (client.auth as any).createOrder({
        nonce: client.nonce(), wallet: client.wallet, market: m.market,
        side: side === "buy" ? kperps.OrderSide.buy : kperps.OrderSide.sell,
        type: kperps.OrderType.market,
        quantity: qty,
      });
      log(`    ✓ opened ${side} ${qty} ${m.market} (~$${notional})`);
      opened++;
    } catch (e: any) {
      const msg = e?.response?.data?.message ?? e?.message ?? String(e);
      log(`    ✗ ${m.market} seed ${side} ${qty}: ${String(msg).slice(0, 100)}`);
    }
  }
  return opened;
}

/**
 * One small market order toward the strategy's signal, so the vault keeps trading even when nobody
 * crosses its post-only ladder (on a quiet book, nobody does, and the vault shows quotes but no
 * trades). One clip (quoteNotionalUsd) in the signal's direction until the position reaches
 * maxPositionUsd, then one clip back, so at the cap it alternates trim and re-add rather than going
 * quiet. A position against the signal is reduced first; with no signal it is worked back toward
 * flat. Returns the signed base quantity it sent (0 when it sent nothing).
 */
export async function takeSignalTrade(
  client: Client, m: MarketInfo, cfg: MarketMakingConfig, netPosition: number, bias: number,
  log: (msg: string) => void, dryRun: boolean,
): Promise<number> {
  const clip = Number(snapQty(cfg.quoteNotionalUsd / m.indexPrice, m.stepSize, m.takerOrderMinimum));
  const dir = Math.sign(bias);
  let side: "buy" | "sell", qty = clip, why: string;
  if (dir === 0) {
    if (Math.abs(netPosition) < clip) return 0;
    side = netPosition > 0 ? "sell" : "buy"; why = "no signal, working the position toward flat";
  } else if (netPosition * dir < 0) {
    side = dir > 0 ? "buy" : "sell"; why = "against the signal, reducing";
    qty = Math.min(clip, Math.abs(netPosition));
  } else if ((Math.abs(netPosition) + clip) * m.indexPrice <= cfg.maxPositionUsd) {
    side = dir > 0 ? "buy" : "sell"; why = "adding with the signal";
  } else {
    side = dir > 0 ? "sell" : "buy"; why = `at the $${cfg.maxPositionUsd} cap, trimming`;
  }
  const quantity = snapQty(qty, m.stepSize, m.takerOrderMinimum);
  if (dryRun) { log(`    · would ${side} ${quantity} ${m.market} at market (${why})`); return 0; }
  try {
    await (client.auth as any).createOrder({
      nonce: client.nonce(), wallet: client.wallet, market: m.market,
      side: side === "buy" ? kperps.OrderSide.buy : kperps.OrderSide.sell,
      type: kperps.OrderType.market, quantity,
      // Self-trade prevention is per API ACCOUNT. With the default (dc) a market order that meets a
      // resting order of any wallet in the same account is decremented with no trade — on dev that
      // ate most fills, because an abandoned loadgen's orders sit in the same accounts. Cancel-oldest
      // removes that resting order and keeps matching.
      selfTradePrevention: kperps.SelfTradePrevention.co,
    });
    log(`    ✓ took ${side} ${quantity} ${m.market} at market (${why})`);
    return (side === "buy" ? 1 : -1) * Number(quantity);
  } catch (e: any) {
    const why2 = e?.response?.data?.message ?? e?.response?.data?.code ?? e?.message ?? String(e);
    log(`    ✗ ${m.market} taker ${side} ${quantity}: ${String(why2).slice(0, 110)}`);
    return 0;
  }
}

/** Best resting bid / ask on a market, or {} when the read fails or a side is empty. */
async function fetchBookTop(client: Client, market: string): Promise<BookTop> {
  try {
    const ob: any = await (client.public as any).getOrderBookLevel1({ market });
    return { bid: ob?.bids?.[0] ? Number(ob.bids[0][0]) : undefined, ask: ob?.asks?.[0] ? Number(ob.asks[0][0]) : undefined };
  } catch { return {}; }
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

/**
 * Replace this market's quotes: cancel, optionally take one signal trade (`taker`, between the
 * cancel and the new ladder so it can never meet our own quotes), then place the freshly skewed
 * ladder against the book as it stands without our orders.
 */
export async function requoteMarket(
  client: Client, m: MarketInfo, cfg: MarketMakingConfig, netPosition: number,
  log: (msg: string) => void, dryRun: boolean, taker?: { bias: number },
): Promise<number> {
  if (!dryRun) await (client.auth as any).cancelOrders({ nonce: client.nonce(), wallet: client.wallet, market: m.market });
  if (taker) netPosition += await takeSignalTrade(client, m, cfg, netPosition, taker.bias, log, dryRun);
  const book = await fetchBookTop(client, m.market);
  const { quotes, note } = buildSkewedQuotes(m, cfg, netPosition, book);
  log(`    ${m.market.padEnd(9)} idx=${m.indexPrice}  ${note}  quotes=${quotes.length}`);
  if (dryRun) {
    for (const q of quotes.slice(0, 4)) log(`      ${q.side.padEnd(4)} ${q.price} x ${q.quantity}`);
    if (quotes.length > 4) log(`      … +${quotes.length - 4} more`);
    return 0;
  }
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
      // e.message is only "Request failed with status code 400" — the reason lives in
      // response.data. Logging the former hid 216 identical failures behind a useless string.
      const why = e?.response?.data?.message ?? e?.response?.data?.code ?? e?.message ?? String(e);
      log(`      ! ${q.side} ${q.price}: ${String(why).slice(0, 110)}`);
    }
  }
  return placed;
}
