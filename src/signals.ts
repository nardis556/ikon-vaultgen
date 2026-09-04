/**
 * signals.ts — the actual trading rules.
 *
 * An indicator is a measurement; a strategy is the decision rule wrapped around it. Everything
 * here is the second thing: each entry pins the indicator, its parameters, the timeframe, and what
 * bias that produces. Nothing is left implied, because "MACD" on its own says nothing about when
 * to be long.
 *
 * A signal returns a bias in {-1, 0, +1}. The market maker keeps quoting both sides regardless —
 * the bias decides which side it opens inventory on and which way the ladder leans. That split
 * matters: the spread is the edge, and the signal only says which way to be wrong-footed.
 */
import { config } from "./config.js";

export interface Candle { start: number; open: number; high: number; low: number; close: number; volume: number; }
export interface SignalResult { bias: -1 | 0 | 1; reason: string; }

export type SignalSpec =
  | { kind: "ema-cross";  interval: string; fast: number; slow: number }
  | { kind: "macd";       interval: string; fast: number; slow: number; signal: number }
  | { kind: "rsi";        interval: string; period: number; low: number; high: number }
  | { kind: "donchian";   interval: string; period: number; atrPeriod: number; atrMult: number }
  | { kind: "bollinger";  interval: string; period: number; stddev: number }
  | { kind: "none" };

export async function fetchCandles(market: string, interval: string, limit: number): Promise<Candle[]> {
  const url = `${config.baseUrl}/candles?market=${encodeURIComponent(market)}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { headers: { "User-Agent": "ikon-vaultgen" } });
  if (!res.ok) throw new Error(`GET /candles ${market} ${interval}: HTTP ${res.status}`);
  const raw: any[] = await res.json();
  return raw.map((c) => ({
    start: Number(c.start), open: Number(c.open), high: Number(c.high),
    low: Number(c.low), close: Number(c.close), volume: Number(c.volume ?? 0),
  })).sort((a, b) => a.start - b.start);
}

// ── indicators ──────────────────────────────────────────────────────────────
export function ema(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  // Seed with an SMA so the first value is not dominated by a single print.
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out.push(prev); }
  return out;
}

/** Wilder's RSI — the smoothing matters; a plain average gives noticeably different levels. */
export function rsi(values: number[], period: number): number[] {
  if (values.length < period + 1) return [];
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  const out = [loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)];
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out.push(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  }
  return out;
}

export function macd(values: number[], fast: number, slow: number, signalPeriod: number) {
  const ef = ema(values, fast), es = ema(values, slow);
  if (!ef.length || !es.length) return { macd: [] as number[], signal: [] as number[], hist: [] as number[] };
  // ema() returns arrays of different lengths (they start at different bars); align on the tail.
  const n = Math.min(ef.length, es.length);
  const line = ef.slice(-n).map((v, i) => v - es.slice(-n)[i]);
  const sig = ema(line, signalPeriod);
  const m = Math.min(line.length, sig.length);
  return { macd: line.slice(-m), signal: sig.slice(-m), hist: line.slice(-m).map((v, i) => v - sig.slice(-m)[i]) };
}

/** True range average (Wilder) — used as a breakout filter, not a signal on its own. */
export function atr(c: Candle[], period: number): number {
  if (c.length < period + 1) return 0;
  let sum = 0;
  for (let i = c.length - period; i < c.length; i++) {
    sum += Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  }
  return sum / period;
}

export function stddev(values: number[], period: number): number {
  const s = values.slice(-period);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
}

// ── the rules ───────────────────────────────────────────────────────────────
export async function evaluateSignal(market: string, spec: SignalSpec): Promise<SignalResult> {
  if (spec.kind === "none") return { bias: 0, reason: "no signal — pure market making" };

  const need = { "ema-cross": (s: any) => s.slow + 60, macd: (s: any) => s.slow + s.signal + 60,
                 rsi: (s: any) => s.period + 60, donchian: (s: any) => Math.max(s.period, s.atrPeriod) + 20,
                 bollinger: (s: any) => s.period + 20 }[spec.kind]!(spec as any);
  const c = await fetchCandles(market, (spec as any).interval, Math.min(500, Math.max(need, 60)));
  const close = c.map((x) => x.close);
  if (close.length < 20) return { bias: 0, reason: `only ${close.length} candles — not enough history` };

  switch (spec.kind) {
    case "ema-cross": {
      const f = ema(close, spec.fast), s = ema(close, spec.slow);
      if (!f.length || !s.length) return { bias: 0, reason: "insufficient history for EMA" };
      const fv = f[f.length - 1], sv = s[s.length - 1];
      const bias = fv > sv ? 1 : fv < sv ? -1 : 0;
      return { bias, reason: `EMA${spec.fast} ${fv.toFixed(2)} ${fv > sv ? ">" : "<"} EMA${spec.slow} ${sv.toFixed(2)} → ${bias > 0 ? "long" : "short"}` };
    }
    case "macd": {
      const m = macd(close, spec.fast, spec.slow, spec.signal);
      if (!m.hist.length) return { bias: 0, reason: "insufficient history for MACD" };
      const h = m.hist[m.hist.length - 1];
      const bias = h > 0 ? 1 : h < 0 ? -1 : 0;
      return { bias, reason: `MACD(${spec.fast},${spec.slow},${spec.signal}) hist ${h.toFixed(3)} → ${bias > 0 ? "long" : "short"}` };
    }
    case "rsi": {
      const r = rsi(close, spec.period);
      if (!r.length) return { bias: 0, reason: "insufficient history for RSI" };
      const rv = r[r.length - 1];
      // Mean reversion: buy oversold, sell overbought, stand aside in the middle.
      const bias = rv < spec.low ? 1 : rv > spec.high ? -1 : 0;
      return { bias, reason: `RSI(${spec.period}) ${rv.toFixed(1)} → ${bias > 0 ? "oversold, long" : bias < 0 ? "overbought, short" : "neutral, no entry"}` };
    }
    case "donchian": {
      const win = c.slice(-spec.period - 1, -1);
      const upper = Math.max(...win.map((x) => x.high)), lower = Math.min(...win.map((x) => x.low));
      const a = atr(c, spec.atrPeriod), last = close[close.length - 1];
      // ATR filter: require the break to clear the channel by a fraction of true range,
      // otherwise every touch of the band counts as a breakout.
      const bias = last > upper + a * spec.atrMult ? 1 : last < lower - a * spec.atrMult ? -1 : 0;
      return { bias, reason: `close ${last.toFixed(2)} vs ${spec.period}-bar channel [${lower.toFixed(2)}, ${upper.toFixed(2)}] ATR ${a.toFixed(2)} → ${bias > 0 ? "upside break" : bias < 0 ? "downside break" : "inside channel, no entry"}` };
    }
    case "bollinger": {
      const mid = close.slice(-spec.period).reduce((a, b) => a + b, 0) / spec.period;
      const sd = stddev(close, spec.period);
      const last = close[close.length - 1];
      const up = mid + sd * spec.stddev, lo = mid - sd * spec.stddev;
      // Fade the band: short the upper, buy the lower.
      const bias = last > up ? -1 : last < lo ? 1 : 0;
      return { bias, reason: `close ${last.toFixed(2)} vs BB(${spec.period},${spec.stddev}σ) [${lo.toFixed(2)}, ${up.toFixed(2)}] → ${bias > 0 ? "below lower, long" : bias < 0 ? "above upper, short" : "inside bands, no entry"}` };
    }
  }
}
