import { createClient } from "redis";

export async function testRedis(
    port: number,
    password: string,
    testData: {
        redis: string
    },
    host = "localhost"
) {
    const client = createClient({
        url: `redis://:${password}@${host}:${port}`
    });

    await client.connect();

    const keyName = testData.redis;

    await client.set(keyName, JSON.stringify(testData));
    const value = await client.get(keyName);
    await client.close();

    return value ? JSON.parse(value) : null;
}
