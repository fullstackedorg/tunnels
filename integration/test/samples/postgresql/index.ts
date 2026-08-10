import { maybeTunnel } from "../tunnel.ts";
import { testPostgreSQL } from "./test.ts";

globalThis.testResult(await testPostgreSQL(
    Number(process.env.POSTGRES_PORT!),
    process.env.USERNAME!,
    process.env.PASSWORD!,
    globalThis.testData,
    await maybeTunnel(globalThis.tunnel)
));
