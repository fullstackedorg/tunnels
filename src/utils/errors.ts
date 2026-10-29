const NETWORK_CODES = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EPIPE",
]);

const REDIS_CONNECTION_ERRORS = new Set([
    "ClientClosedError",
    "ClientOfflineError",
    "ConnectionTimeoutError",
    "SocketClosedUnexpectedlyError",
    "ReconnectStrategyError",
]);

/**
 * True when an error means storage or KV is unreachable (reported as 503), as opposed to a
 * bug or invalid input (reported as 500 / 4xx).
 */
export function isUnavailableError(err: any): boolean {
    if (!err) return false;
    if (err.statusCode === 503) return true;
    if (NETWORK_CODES.has(err.code)) return true;
    // PostgreSQL class 08 (connection exception) and 57P01-57P03 (shutdown / cannot connect)
    if (typeof err.code === "string" && /^(08|57P0[1-3])/.test(err.code)) return true;
    if (REDIS_CONNECTION_ERRORS.has(err.name)) return true;
    return typeof err.message === "string" && err.message.startsWith("Timeout acquiring lock");
}

/** True for a unique-token collision raised by a storage provider. */
export function isConflictError(err: any): boolean {
    return typeof err?.message === "string" && err.message.startsWith("Conflict");
}
