import { Cl } from "@stacks/transactions";
import { call } from "./call.mjs";
const MARKET = Buffer.from("fab06a536002d851906237efbbd43bcbc84a78f409519765e98103fa886ec510","hex");
await call("redeem", [Cl.buffer(MARKET)], 20000);
