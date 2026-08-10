import { maybeTunnel } from "../tunnel";
import { testMySQL } from "./test";

globalThis.testResult(await testMySQL(
    Number(process.env.MYSQL_PORT!),
    process.env.PASSWORD!,
    globalThis.testData,
    await maybeTunnel(globalThis.tunnel)
));