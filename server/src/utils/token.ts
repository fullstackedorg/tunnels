import crypto from "node:crypto";

export function generateToken() {
    return crypto.randomBytes(32).toString("base64url");
}
