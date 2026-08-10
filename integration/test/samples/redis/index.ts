import { maybeTunnel } from "../tunnel.ts";
import { testRedis } from "./test.ts";

globalThis.testResult(await testRedis(
    Number(process.env.REDIS_PORT!),
    process.env.PASSWORD!,
    globalThis.testData,
    await maybeTunnel(globalThis.tunnel)
));
