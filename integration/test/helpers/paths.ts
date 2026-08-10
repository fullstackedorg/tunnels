
import fs from "node:fs";
import path from "node:path"

export const tmpDir = ".tmp"

if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
}

export const samplesDir = path.join("test", "samples")
