/** index.ts — entry point. MODE=provision | animate | list */
import { config } from "./config.js";
import { listStrategies } from "./strategy.js";

async function main() {
  switch (config.mode) {
    case "list":
      for (const s of listStrategies()) console.log(`${s.id.padEnd(24)} ${s.profile.padEnd(20)} ${s.name}`);
      return;
    case "provision": return (await import("./provision.js")).provision();
    case "animate":   return (await import("./animate.js")).animate();
    case "fund":      return (await import("./fund.js")).fund();
    default: throw new Error(`Unknown MODE "${config.mode}" (provision | fund | animate | list)`);
  }
}
main().catch((e) => { console.error(`\nFATAL: ${e?.message ?? e}`); process.exit(1); });
