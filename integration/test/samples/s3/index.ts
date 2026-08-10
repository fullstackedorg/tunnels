import { maybeTunnel } from "../tunnel.ts";
import { testS3 } from "./test.ts";

globalThis.testResult(await testS3(
    Number(process.env.S3_PORT!),
    process.env.USERNAME!,
    process.env.PASSWORD!,
    globalThis.testData,
    await maybeTunnel(globalThis.tunnel)
));
