import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packageJsonPath = path.resolve(__dirname, "package.json");

function getVersion(): string {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const currentVersion: string = packageJson.version || "0.0.1";
    const baseVersion = currentVersion.split("-")[0];

    try {
        const branch = execSync("git rev-parse --abbrev-ref HEAD", {
            encoding: "utf-8",
        })
            .trim()
            .replace(/\//g, "-");
        const rawCommitCount = execSync("git rev-list --count HEAD", {
            encoding: "utf-8",
        }).trim();
        const offset = parseInt(process.env.COMMIT_OFFSET || "0", 10);
        const commitCount = (parseInt(rawCommitCount, 10) + offset).toString();
        return `${baseVersion}-${branch}.${commitCount}`;
    } catch {
        return currentVersion;
    }
}

function updatePackageVersion() {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const newVersion = getVersion();
    if (packageJson.version !== newVersion) {
        packageJson.version = newVersion;
        fs.writeFileSync(
            packageJsonPath,
            JSON.stringify(packageJson, null, 4) + "\n",
        );
        console.log(`Updated package.json version to ${newVersion}`);
    }
}

updatePackageVersion();
