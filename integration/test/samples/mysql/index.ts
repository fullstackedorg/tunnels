import { maybeTunnel } from "../tunnel.ts";
import { testMySQL } from "./test.ts";

globalThis.testResult(await testMySQL(
    Number(process.env.MYSQL_PORT!),
    process.env.PASSWORD!,
    globalThis.testData,
    await maybeTunnel(globalThis.tunnel)
));