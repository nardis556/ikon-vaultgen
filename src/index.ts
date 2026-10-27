/** index.ts — entry point. MODE=provision | animate | details | associate | fund | list */
import { config } from "./config.js";
import { listStrategies } from "./strategy.js";

async function main() {
  switch (config.mode) {
    case "list":
      for (const s of listStrategies()) console.log(`${s.id.padEnd(24)} ${s.profile.padEnd(20)} ${s.name}`);
      return;
    case "provision": return (await import("./provision.js")).provision();
    case "animate":   return (await import("./animate.js")).animate();
    case "details":   return (await import("./details.js")).details();
    // associate + fund operate on the PERSISTENT wallet pool. Under FRESH_WALLETS there is no pool
    // (provision mints + funds fresh wallets inline each run), so they are no-ops — skip cleanly
    // rather than minting throwaway wallets or throwing.
    case "associate":
      if (config.freshWallets) { console.log("FRESH_WALLETS=1: no persistent pool to associate — provision handles fresh wallets inline. Skipping."); return; }
      return (await import("./associate.js")).associateAll();
    case "fund":
      if (config.freshWallets) { console.log("FRESH_WALLETS=1: no persistent pool to pre-fund — provision funds fresh wallets inline. Skipping."); return; }
      return (await import("./fund.js")).fund();
    default: throw new Error(`Unknown MODE "${config.mode}" (associate | fund | provision | animate | details | list)`);
  }
}
main().catch((e) => { console.error(`\nFATAL: ${e?.message ?? e}`); process.exit(1); });
