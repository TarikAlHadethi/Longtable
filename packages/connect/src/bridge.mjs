// The terminal bridge's own process (started by forkBridge in local.mjs). It serves the person's terminals and nothing
// else; the connection tells it which tables it may serve, and when the connection ends, so does it.
import { startBridge } from "./local.mjs";
import { log } from "./store.mjs";

let seats = [];
process.on("message", async (m) => {
  if (m?.start) {
    seats = m.start.seats;
    try {
      const bridge = await startBridge({ app: m.start.app, seats, home: m.start.home, log });
      process.on("disconnect", () => { bridge.close(); process.exit(0); });
      process.send({ port: bridge.port });
    } catch (e) {
      process.send({ error: e.message });
      process.exit(1);
    }
  } else if (m?.allow) {
    for (const s of seats) if (s.table_id === m.allow.table) s.local.allowed = !!m.allow.on;
  }
});
// A fault in a terminal is written down and the rest go on, as in the connection itself.
process.on("uncaughtException", (e) => log(`tripwire: the terminal bridge: ${e.message}`));
process.on("unhandledRejection", (e) => log(`tripwire: the terminal bridge: ${e?.message || e}`));
