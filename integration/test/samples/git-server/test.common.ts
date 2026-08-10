import fs from "fs";
import path from "path";

export const readTestFile = (dir: string) => {
    const content = fs.readFileSync(path.join(dir, "test.txt"), "utf-8").trim();
    fs.rmSync(dir, { recursive: true, force: true });
    return content;
};