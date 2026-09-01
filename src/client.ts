/** client.ts — authenticated SDK client (same shape as the loadgen's, for familiarity). */
import * as kperps from "@katanaperps/katana-perps-sdk";
import { ethers } from "ethers";
import { v1 as uuidv1 } from "uuid";
import { config } from "./config.js";

export type Client = ReturnType<typeof buildClient>;

export function buildClient(apiKey: string, apiSecret: string, walletPrivateKey: string) {
  const auth = new kperps.RestAuthenticatedClient({
    bridgeAdapterContractAddress: config.depositAdapter,
    apiKey, apiSecret, walletPrivateKey,
    baseURL: config.baseUrl,
    chainId: config.chainId,
    sandbox: config.sandbox,
    exchangeContractAddress: config.exchangeContract,
  });
  return { auth, public: auth.public, wallet: ethers.computeAddress(walletPrivateKey), nonce: () => uuidv1() };
}

/** Unauthenticated public client — markets, index prices. */
export function buildPublicClient() {
  return new kperps.RestPublicClient({
    baseURL: config.baseUrl, chainId: config.chainId, sandbox: config.sandbox,
    exchangeContractAddress: config.exchangeContract,
  } as any);
}
