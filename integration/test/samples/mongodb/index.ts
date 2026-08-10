import { maybeTunnel } from "../tunnel.ts";
import { testMongoDB } from "./test.ts";

globalThis.testResult(await testMongoDB(
    Number(process.env.MONGODB_PORT!),
    process.env.USERNAME!,
    process.env.PASSWORD!,
    globalThis.testData,
    await maybeTunnel(globalThis.tunnel)
));