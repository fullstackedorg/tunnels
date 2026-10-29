process.env.TEST = "1";

export const PORTS = {
    mysql: parseInt(process.env.TEST_MYSQL_PORT || "3306", 10),
    redis: parseInt(process.env.TEST_REDIS_PORT || "6379", 10),
    postgres: parseInt(process.env.TEST_PG_PORT || "5432", 10),
    http: parseInt(process.env.TEST_HTTP_PORT || "8080", 10),
    socketTcp: parseInt(process.env.TEST_SOCKET_TCP_PORT || "9001", 10),
    socketWs: parseInt(process.env.TEST_SOCKET_WS_PORT || "9002", 10),
    s3: parseInt(process.env.TEST_S3_PORT || "9000", 10),
    git: parseInt(process.env.TEST_GIT_PORT || "8085", 10),
    mongo: parseInt(process.env.TEST_MONGO_PORT || "27017", 10),
} as const;

export const CREDENTIALS = {
    mysql: {
        host: "127.0.0.1",
        user: "root",
        password: "secret",
        database: "test",
    },
    redis: {
        host: "127.0.0.1",
        password: "secret",
    },
    postgres: {
        host: "127.0.0.1",
        user: "postgres",
        password: "secret",
        database: "postgres",
    },
    s3: {
        endpoint: `http://127.0.0.1:${PORTS.s3}`,
        region: "us-east-1",
        accessKeyId: "rustfsadmin",
        secretAccessKey: "rustfsadmin",
    },
    git: {
        username: "test",
        password: "testing",
    },
    mongo: {
        username: "root",
        password: "secret",
    },
} as const;
