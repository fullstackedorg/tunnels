import { MongoClient } from "mongodb";

export async function testMongoDB(
    port: number,
    user: string,
    password: string,
    testData: {
        mongodb: string
    },
    host = "localhost"
) {
    const uri = `mongodb://${user}:${password}@${host}:${port}`;
    const client = new MongoClient(uri);

    await client.connect();
    const dbName = "testdb";
    const collectionName = testData.mongodb;
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    await collection.insertOne({ payload: testData });
    const result = await collection.findOne({}, { sort: { _id: -1 } });

    await client.close();

    return result?.payload;
}
