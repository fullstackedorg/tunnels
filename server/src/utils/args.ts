// find in process.env[name[x]] or process.argv[y]
// allowing:
// * SOME_ARG=value
// * --arg=value
// * --arg value
// * -a=value
// * -a value
export function getEnvOrArgCLI(name: string[]): string | undefined;
export function getEnvOrArgCLI(
    name: string[],
    valueType: "string",
): string | undefined;
export function getEnvOrArgCLI(
    name: string[],
    valueType: "number",
): number | undefined;
export function getEnvOrArgCLI(
    name: string[],
    valueType: "boolean",
): boolean | undefined;
export function getEnvOrArgCLI(
    name: string[],
    valueType: "string" | "number" | "boolean" = "string",
): string | number | boolean | undefined {
    for (const n of name) {
        if (process.env[n] !== undefined) {
            return castValueType(process.env[n], valueType);
        }
    }

    for (let i = 0; i < process.argv.length; i++) {
        const arg = process.argv[i];

        for (const n of name) {
            const options = [n, `--${n}`];
            if (n.length === 1) options.push(`-${n}`);

            for (const opt of options) {
                if (arg === opt) {
                    const nextArg = process.argv[i + 1];
                    if (nextArg !== undefined && !nextArg.startsWith("-")) {
                        return castValueType(nextArg, valueType);
                    }
                    return castValueType("true", valueType);
                }

                if (arg.startsWith(`${opt}=`)) {
                    return castValueType(arg.slice(opt.length + 1), valueType);
                }
            }
        }
    }

    return undefined;
}

function castValueType(
    value: string,
    valueType: "string" | "number" | "boolean",
) {
    switch (valueType) {
        case "string":
            return value;
        case "number":
            return Number(value);
        case "boolean":
            return Boolean(value);
    }
}
