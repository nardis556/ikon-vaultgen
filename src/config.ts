/**
 * config.ts — environment for one vaultgen deployment.
 *
 * Precedence: real process env  >  .env.STRATEGY  >  .env
 * dotenv's default (override:false) only fills vars that are not already set, so loading the most
 * specific file FIRST produces that order. Do NOT use override:true — it would let .env.STRATEGY
 * clobber `docker compose run -e EXECUTE=1` back to 0, silently turning a live run into a dry run.
 */
import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env.STRATEGY") });
dotenv.config({ path: resolve(__dirname, "../.env") });

const required = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var: ${k}`);
  return v;
};
const optional = (k: string, d: string): string => process.env[k] ?? d;
const num = (k: string, d: string) => Number(optional(k, d));

export const config = {
  // ── API / chain ───────────────────────────────────────────────────────────
  baseUrl:          required("BASE_URL"),
  chainId:          parseInt(required("CHAIN_ID")),
  sandbox:          optional("SANDBOX", "true") === "true",
  rpcUrl:           required("RPC_URL"),
  exchangeContract: required("EXCHANGE_CONTRACT"),
  vaultProvider:    required("VAULT_PROVIDER"),
  depositAdapter:   required("LOCAL_DEPOSIT_ADAPTER"),
  quoteToken:       required("QUOTE_TOKEN"),
  lzEndpointId:     parseInt(optional("LZ_ENDPOINT_ID", "40448")),

  // ── Which vault this deployment drives ────────────────────────────────────
  strategy:         required("STRATEGY"),
  instance:         optional("INSTANCE", "1"),

  // ── Funding ───────────────────────────────────────────────────────────────
  fundingKey:       required("FUNDING_WALLET_KEY"),
  // Optional BIP-39 phrase. Set it and every strategy's manager + depositor pool becomes
  // deterministic, so the addresses can be pre-funded once in bulk (MODE=fund) and stay stable
  // across re-runs. Unset = random wallets funded just-in-time.
  poolMnemonic:     optional("POOL_MNEMONIC", ""),
  // Target balances used by MODE=fund when pre-funding the pool.
  fundDepUsd:       optional("FUND_DEPOSITOR_USD", ""),   // blank = derive from strategy range
  mgrEth:           optional("MGR_ETH", "0.004"),
  depEth:           optional("DEP_ETH", "0.002"),

  // Manager API credentials come from .env.MANAGER (fields 3/4), NOT from env —
  // that keeps .env.STRATEGY committable.

  // ── Behaviour ─────────────────────────────────────────────────────────────
  mode:             optional("MODE", "provision"),   // provision | animate | list
  execute:          optional("EXECUTE", "0") === "1",
  setDetails:       optional("SET_DETAILS", "1") === "1",
  generateWallets:  optional("GENERATE_WALLETS", "1") === "1",
  settleMs:         num("SETTLE_MS", "15000"),

  // Depositor pool. Larger than the vault's initial depositor count means the churn
  // daemon can bring NEW depositors in over time instead of only recycling the
  // original ten — which is what a real vault's depositor list looks like.
  depositorPoolSize: num("DEPOSITOR_POOL_SIZE", "0"),   // 0 = same as strategy count

  // ── Daemon knobs (override the strategy file when set) ────────────────────
  churnEnabled:     optional("CHURN_ENABLED", "") === "" ? null : optional("CHURN_ENABLED", "") === "1",
  mmEnabled:        optional("MM_ENABLED", "") === "" ? null : optional("MM_ENABLED", "") === "1",
  // Compress the churn clock for demos: 24h of scheduled activity in TIME_SCALE seconds
  // of wall clock. 1 = real time. Use e.g. 0.001 to watch a week pass in minutes.
  timeScale:        num("TIME_SCALE", "1"),
  tickSeconds:      num("TICK_SECONDS", "30"),

  outDir:           optional("OUT_DIR", "/app/out"),
  stateDir:         optional("STATE_DIR", "/app/state"),
};
