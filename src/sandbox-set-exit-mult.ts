/**
 * Lower the EXIT threshold (maximumTotalOwedQuantityAvailableMultiplierToInitiateExit) on the
 * sandbox demo vaults so it sits BELOW the manager-withdrawal threshold — otherwise a manager could
 * push the vault into exit-eligibility with a perfectly valid withdrawal.
 *
 *   MODE=initiate  npx tsx src/sandbox-set-exit-mult.ts   → initiateManagedAccountUpgrade per vault
 *   MODE=finalize  npx tsx src/sandbox-set-exit-mult.ts   → waits for each threshold, finalizes, verifies
 *   MODE=status    npx tsx src/sandbox-set-exit-mult.ts   → prints current + pending config
 *
 * Targets (strategy → new exit %) in TARGETS. Every other field is copied from the live config.
 * Manager keys are read from docker/sandbox/<strategy>/.env.MANAGER at runtime and never printed.
 */
import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { encodeFixedIncomeVaultConfigurationFields } from "@katanaperps/katana-perps-sdk";

const ROOT = "/home/user/code/kperps-test/ikon-vaultgen";
const TARGETS: Record<string, number> = JSON.parse(process.env.TARGETS ?? '{"ema-trend":65,"macd-crossover":60,"rsi-pullback":70}');
const STATE = `${ROOT}/docker/sandbox/.exit-mult-upgrade-state.json`;
const MODE = process.env.MODE ?? "status";

const env: Record<string, string> = {};
for (const l of readFileSync(`${ROOT}/docker/sandbox/.env.sandbox`, "utf8").split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/); if (m) env[m[1]] = m[2].trim(); }
const p = new ethers.JsonRpcProvider(env.RPC_URL ?? "https://rpc-bokuto.katanarpc.com/", 737373, { staticNetwork: true });
const PROVIDER = env.VAULT_PROVIDER!;
const ABI = [
  "function loadVaultConfigurationsLength(address) view returns (uint256)",
  "function loadVaultConfiguration(address,uint256) view returns ((address,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64))",
  "function vaultConfigurationUpgradesByManagerWallet(address) view returns (bool exists, (address,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64) newFields, uint256 blockTimestampThreshold)",
  "function managedAccountUpgradeBlockTimestampDelayInS() view returns (uint256)",
  "function initiateManagedAccountUpgrade(bytes payload)",
  "function finalizeManagedAccountUpgrade()",
  "function cancelManagedAccountUpgrade()",
];
const pct = (v: bigint | number) => (Number(v) / 1e6).toFixed(2) + "%";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const managerKey = (strategy: string): string => {
  const line = readFileSync(`${ROOT}/docker/sandbox/${strategy}/.env.MANAGER`, "utf8").split("\n").find((l) => l.startsWith("MANAGER="))!;
  return line.slice("MANAGER=".length).split(",")[1].trim();
};
const read = new ethers.Contract(PROVIDER, ABI, p) as any;
const loadState = (): Record<string, any> => existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const saveState = (s: any) => writeFileSync(STATE, JSON.stringify(s, null, 1));

async function current(mgr: string) {
  const n = Number(await read.loadVaultConfigurationsLength(mgr));
  const f = await read.loadVaultConfiguration(mgr, n - 1);
  return { n, fields: { interest: f[2], maxNet: f[3], exitMult: f[4], mgrWithdrawMult: f[5], unappliedAge: f[6], depLimit: f[7], vaultLimit: f[8] } };
}
const describe = (f: any) => `exit=${pct(f.exitMult)} mgrWithdraw=${pct(f.mgrWithdrawMult)} interest=${pct(f.interest)} maxNet=$${Number(f.maxNet) / 1e8} age=${f.unappliedAge}s depLimit=${pct(f.depLimit)} vaultLimit=${pct(f.vaultLimit)}`;

async function main() {
  const delay = Number(await read.managedAccountUpgradeBlockTimestampDelayInS());
  const state = loadState();
  for (const [strategy, newPct] of Object.entries(TARGETS)) {
    const mgr = new ethers.Wallet(managerKey(strategy), p);
    const { n, fields } = await current(mgr.address);
    const pending = await read.vaultConfigurationUpgradesByManagerWallet(mgr.address);
    console.log(`\n${strategy}  manager ${mgr.address}  configs=${n}\n  current : ${describe(fields)}`);
    if (pending.exists) console.log(`  pending : exit=${pct(pending.newFields[4])} finalizable at ${new Date(Number(pending.blockTimestampThreshold) * 1000).toISOString()}`);

    if (MODE === "initiate") {
      if (pending.exists && process.env.CANCEL_PENDING === "1") {
        const c0 = new ethers.Contract(PROVIDER, ABI, mgr) as any;
        const rc0 = await (await c0.cancelManagedAccountUpgrade({ gasLimit: 400_000 })).wait();
        if (rc0.status !== 1) throw new Error(`cancel failed for ${strategy}: ${rc0.hash}`);
        console.log(`  ✓ cancelled the stale pending upgrade (would have set mgrWithdraw=${pct(pending.newFields[5])})  tx ${rc0.hash}`);
      } else if (pending.exists) { console.log("  ! an upgrade is already pending — skipping initiate (set CANCEL_PENDING=1 to replace it)"); continue; }
      const newExit = BigInt(Math.round(newPct * 1e6));
      if (newExit >= fields.mgrWithdrawMult) { console.log(`  ! target ${newPct}% is not below the manager-withdrawal threshold ${pct(fields.mgrWithdrawMult)} — skipping`); continue; }
      if (newExit < 50_000_000n) { console.log("  ! below the contract minimum of 50% — skipping"); continue; }
      const payload = encodeFixedIncomeVaultConfigurationFields({
        managerWallet: mgr.address, effectiveTimestampInS: 0,
        interestMultiplierInPips: fields.interest, maximumNetDepositsInPips: fields.maxNet,
        maximumTotalOwedQuantityAvailableForExitWithdrawalMultiplierNeededToInitiateExitInPips: newExit,
        minimumTotalOwedQuantityAvailableForExitWithdrawalMultiplierToAllowManagerWalletWithdrawalInPips: fields.mgrWithdrawMult,
        minimumUnappliedWithdrawalAgeInSNeededToInitiateExit: Number(fields.unappliedAge),
        withdrawalLimitPercentForDepositorsInPips: fields.depLimit, withdrawalLimitPercentForVaultInPips: fields.vaultLimit,
      } as any);
      const c = new ethers.Contract(PROVIDER, ABI, mgr) as any;
      const tx = await c.initiateManagedAccountUpgrade(payload, { gasLimit: 800_000 });
      const rc = await tx.wait();
      if (rc.status !== 1) throw new Error(`initiate failed for ${strategy}: ${rc.hash}`);
      const after = await read.vaultConfigurationUpgradesByManagerWallet(mgr.address);
      const at = Number(after.blockTimestampThreshold);
      state[strategy] = { manager: mgr.address, newExitPct: newPct, initiatedTx: rc.hash, finalizableAt: at };
      saveState(state);
      console.log(`  ✓ initiated exit ${pct(fields.exitMult)} → ${newPct}%  tx ${rc.hash}  (delay ${delay}s) finalizable at ${new Date(at * 1000).toISOString()}`);
    }

    if (MODE === "finalize") {
      if (!pending.exists) { console.log("  ! nothing pending — skipping"); continue; }
      const at = Number(pending.blockTimestampThreshold);
      let bt = Number((await p.getBlock("latest"))!.timestamp);
      if (bt < at) { console.log(`  … waiting ${at - bt + 5}s for the upgrade delay`); await sleep((at - bt + 5) * 1000); }
      while ((bt = Number((await p.getBlock("latest"))!.timestamp)) < at) await sleep(3000);
      const c = new ethers.Contract(PROVIDER, ABI, mgr) as any;
      const rc = await (await c.finalizeManagedAccountUpgrade({ gasLimit: 800_000 })).wait();
      if (rc.status !== 1) throw new Error(`finalize failed for ${strategy}: ${rc.hash}`);
      const { n: n2, fields: f2 } = await current(mgr.address);
      const ok = f2.exitMult === BigInt(Math.round(newPct * 1e6)) && f2.mgrWithdrawMult === fields.mgrWithdrawMult && f2.interest === fields.interest && f2.maxNet === fields.maxNet && f2.depLimit === fields.depLimit && f2.vaultLimit === fields.vaultLimit && f2.unappliedAge === fields.unappliedAge;
      console.log(`  ${ok ? "✓" : "✗"} finalized tx ${rc.hash}  configs ${n}→${n2}\n  now     : ${describe(f2)}  ${ok ? "(only exit changed; exit < mgrWithdraw)" : "UNEXPECTED FIELD CHANGE"}`);
      state[strategy] = { ...(state[strategy] ?? {}), finalizedTx: rc.hash, verified: ok }; saveState(state);
    }
  }
}
main().catch((e) => { console.error(String(e?.shortMessage ?? e?.reason ?? e?.message ?? e)); process.exit(1); });
