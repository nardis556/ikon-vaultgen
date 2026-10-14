/**
 * associate-one.ts — associate a SINGLE wallet with a staging API account.
 *
 * Secrets come ONLY from the environment and are never logged (masked to last 4 chars):
 *   API_KEY, API_SECRET  — the staging ACCOUNT credentials the wallet joins
 *   WALLET_PK            — the private key of the wallet to associate (it signs the EIP-712 payload)
 *
 * Public params default to staging and can be overridden via env:
 *   BASE_URL, CHAIN_ID, EXCHANGE_CONTRACT, SANDBOX
 *
 * Safety: derives the address from WALLET_PK; if WALLET is set it must match (guards a wrong key).
 * DRY-RUN by default — set EXECUTE=1 to actually send.
 *
 *   API_KEY=... API_SECRET=... WALLET_PK=0x... WALLET=0x5173248c193f72AEeFc71CF2Bd9440767f290e91 \
 *     EXECUTE=1 npx tsx src/associate-one.ts
 */
import * as kperps from "@katanaperps/katana-perps-sdk";
import { Wallet } from "ethers";
import { v1 as uuidv1 } from "uuid";

const BASE_URL = process.env.BASE_URL ?? "https://api-staging.katana-perps-dev.com/v1";
const CHAIN_ID = parseInt(process.env.CHAIN_ID ?? "737373");
const EXCHANGE = process.env.EXCHANGE_CONTRACT ?? "0x4C234fCeA3f8c4C8a7D962a6d8f2214f6ab1D5c4";
const SANDBOX = (process.env.SANDBOX ?? "true") === "true";

const apiKey = process.env.API_KEY ?? "";
const apiSecret = process.env.API_SECRET ?? "";
const pk = process.env.WALLET_PK ?? "";
const expected = (process.env.WALLET ?? "").trim().toLowerCase();
const execute = process.env.EXECUTE === "1";

const mask = (s: string) => (s ? `...${s.slice(-4)}` : "(unset)");

async function main() {
  if (!apiKey || !apiSecret) throw new Error("API_KEY / API_SECRET required (staging account creds)");
  if (!pk) throw new Error("WALLET_PK required (the wallet's private key — it signs the association)");

  const addr = new Wallet(pk).address;
  if (expected && addr.toLowerCase() !== expected) {
    throw new Error(`WALLET_PK derives ${addr} but WALLET expected ${process.env.WALLET} — refusing (wrong key?)`);
  }

  console.log("associate-one (staging)");
  console.log(`  base     : ${BASE_URL}`);
  console.log(`  exchange : ${EXCHANGE}  chain ${CHAIN_ID}  sandbox ${SANDBOX}`);
  console.log(`  apiKey   : ${mask(apiKey)}   apiSecret ${mask(apiSecret)}`);
  console.log(`  wallet   : ${addr}`);

  if (!execute) {
    console.log("  mode     : DRY-RUN — set EXECUTE=1 to send");
    return;
  }

  const client = new kperps.RestAuthenticatedClient({
    apiKey,
    apiSecret,
    walletPrivateKey: pk,
    baseURL: BASE_URL,
    chainId: CHAIN_ID,
    sandbox: SANDBOX,
    exchangeContractAddress: EXCHANGE,
    // associateWallet builds an EIP-712 payload that needs a bridge adapter; Zero = local, no bridge.
    bridgeAdapterContractAddress: "0x0000000000000000000000000000000000000000",
  });

  try {
    await client.associateWallet({ nonce: uuidv1(), wallet: addr });
    console.log(`  ✓ associated ${addr}`);
  } catch (e: any) {
    const code = e?.response?.data?.code ?? "";
    const msg = e?.response?.data?.message ?? e?.message ?? String(e);
    if (/ALREADY|EXISTS|DUPLICATE/i.test(`${code} ${msg}`)) {
      console.log(`  = already associated (no-op)`);
    } else {
      console.log(`  ✗ ${code} ${String(msg).slice(0, 140)}`);
      process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
