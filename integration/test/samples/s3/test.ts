import { S3Client, CreateBucketCommand, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

export async function testS3(
    port: number,
    accessKeyId: string,
    secretAccessKey: string,
    testData: {
        s3: string
    },
    host = "localhost"
) {
    const client = new S3Client({
        endpoint: `http://${host}:${port}`,
        region: "us-east-1",
        credentials: {
            accessKeyId,
            secretAccessKey,
        },
        forcePathStyle: true,
    });

    const bucketName = testData.s3;
    const objectKey = testData.s3 + ".json"

    try {
        await client.send(new CreateBucketCommand({ Bucket: bucketName }));
    } catch (err: any) {
        if (
            err.name !== "BucketAlreadyOwnedByYou" &&
            err.name !== "BucketAlreadyExists" &&
            !err.message?.includes("BucketAlreadyOwnedByYou")
        ) {
            throw err;
        }
    }

    await client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
        Body: JSON.stringify(testData),
        ContentType: "application/json",
    }));

    const response = await client.send(new GetObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
    }));


    const bodyContents = await response.Body?.transformToString();
    client.destroy();
    return bodyContents ? JSON.parse(bodyContents) : null;
}
