import test from "node:test";
import { PORTS, CREDENTIALS } from "./helpers/env.ts";
import {
    setupIntegrationHarness,
    createDirectTunnel,
    createRelayedTunnel,
} from "./helpers/hub-edge.ts";
import { runProgrammatic } from "./helpers/runtime.ts";
import { waitForRustFS } from "./helpers/compose.ts";

test("s3: bucket management, binary payloads, multipart upload, and presigned URL over direct tunnel", async () => {
    await waitForRustFS();
    const harness = await setupIntegrationHarness(false);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createDirectTunnel(
            harness.hubUrl,
            PORTS.s3,
            "127.0.0.1",
            "S3 Direct"
        );

        await runProgrammatic(`
            import tunnel from "fullstacked/tunnel";
            import crypto from "crypto";
            import assert from "assert";
            import {
                S3Client,
                CreateBucketCommand,
                PutObjectCommand,
                GetObjectCommand,
                CreateMultipartUploadCommand,
                UploadPartCommand,
                CompleteMultipartUploadCommand,
            } from "@aws-sdk/client-s3";
            import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

            const host = await tunnel.register({
                host: "127.0.0.1",
                port: ${hubPort},
                authorization: "${token}",
                unsecure: true,
            });

            const s3 = new S3Client({
                endpoint: \`http://\${host}:9000\`,
                region: "us-east-1",
                forcePathStyle: true,
                credentials: {
                    accessKeyId: "${CREDENTIALS.s3.accessKeyId}",
                    secretAccessKey: "${CREDENTIALS.s3.secretAccessKey}",
                },
            });

            const bucket = \`direct-bucket-\${Date.now()}\`;
            await s3.send(new CreateBucketCommand({ Bucket: bucket }));

            // 1. Put & Get binary object
            const binaryPayload = crypto.randomBytes(64 * 1024);
            await s3.send(
                new PutObjectCommand({
                    Bucket: bucket,
                    Key: "test.bin",
                    Body: binaryPayload,
                    ContentType: "application/octet-stream",
                })
            );

            const getRes = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "test.bin" }));
            const downloadedBytes = Buffer.from(await getRes.Body.transformToByteArray());
            assert.ok(downloadedBytes.equals(binaryPayload));

            // 2. Multipart Upload (two 5MB parts)
            const partSize = 5 * 1024 * 1024;
            const part1 = crypto.randomBytes(partSize);
            const part2 = crypto.randomBytes(partSize);

            const multipart = await s3.send(
                new CreateMultipartUploadCommand({
                    Bucket: bucket,
                    Key: "multipart.bin",
                })
            );
            const uploadId = multipart.UploadId;

            const uploadPart1 = await s3.send(
                new UploadPartCommand({
                    Bucket: bucket,
                    Key: "multipart.bin",
                    UploadId: uploadId,
                    PartNumber: 1,
                    Body: part1,
                })
            );

            const uploadPart2 = await s3.send(
                new UploadPartCommand({
                    Bucket: bucket,
                    Key: "multipart.bin",
                    UploadId: uploadId,
                    PartNumber: 2,
                    Body: part2,
                })
            );

            await s3.send(
                new CompleteMultipartUploadCommand({
                    Bucket: bucket,
                    Key: "multipart.bin",
                    UploadId: uploadId,
                    MultipartUpload: {
                        Parts: [
                            { PartNumber: 1, ETag: uploadPart1.ETag },
                            { PartNumber: 2, ETag: uploadPart2.ETag },
                        ],
                    },
                })
            );

            // 3. Presigned URL access
            const presignedUrl = await getSignedUrl(
                s3,
                new GetObjectCommand({ Bucket: bucket, Key: "test.bin" }),
                { expiresIn: 300 }
            );
            const presignedRes = await fetch(presignedUrl);
            assert.equal(presignedRes.status, 200);
            const presignedBytes = Buffer.from(await presignedRes.arrayBuffer());
            assert.ok(presignedBytes.equals(binaryPayload));

            s3.destroy();
        `);
    } finally {
        await harness.close();
    }
});

test("s3: S3 operations through RustFS over edge relayed tunnel", async () => {
    await waitForRustFS();
    const harness = await setupIntegrationHarness(true);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createRelayedTunnel(
            harness.hubUrl,
            harness.edgeId!,
            PORTS.s3,
            "127.0.0.1",
            "S3 Relayed"
        );

        await runProgrammatic(`
            import tunnel from "fullstacked/tunnel";
            import assert from "assert";
            import { S3Client, CreateBucketCommand, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

            const host = await tunnel.register({
                host: "127.0.0.1",
                port: ${hubPort},
                authorization: "${token}",
                unsecure: true,
            });

            const s3 = new S3Client({
                endpoint: \`http://\${host}:9000\`,
                region: "us-east-1",
                forcePathStyle: true,
                credentials: {
                    accessKeyId: "${CREDENTIALS.s3.accessKeyId}",
                    secretAccessKey: "${CREDENTIALS.s3.secretAccessKey}",
                },
            });

            const bucket = \`relayed-bucket-\${Date.now()}\`;
            await s3.send(new CreateBucketCommand({ Bucket: bucket }));

            const testMsg = Buffer.from("Hello RustFS S3 over Relayed Tunnel!");
            await s3.send(
                new PutObjectCommand({
                    Bucket: bucket,
                    Key: "hello.txt",
                    Body: testMsg,
                })
            );

            const getRes = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "hello.txt" }));
            const downloaded = Buffer.from(await getRes.Body.transformToByteArray());
            assert.equal(downloaded.toString("utf-8"), testMsg.toString("utf-8"));

            s3.destroy();
        `);
    } finally {
        await harness.close();
    }
});
