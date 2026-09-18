import { getEnvOrArgCLI } from "./args.ts";
import { executeHook } from "./hooks.ts";

export interface Breadcrumb {
    timestamp: string;
    category: string;
    level: "info" | "warn" | "error" | "debug";
    message: string;
    metadata?: Record<string, any>;
}

export class Logger {
    private breadcrumbs: Breadcrumb[] = [];
    private maxBreadcrumbs = 100;

    public addBreadcrumb(
        category: string,
        level: "info" | "warn" | "error" | "debug",
        message: string,
        metadata?: Record<string, any>,
    ): void {
        const entry: Breadcrumb = {
            timestamp: new Date().toISOString(),
            category,
            level,
            message,
            metadata,
        };
        this.breadcrumbs.push(entry);
        if (this.breadcrumbs.length > this.maxBreadcrumbs) {
            this.breadcrumbs.shift();
        }
        executeHook("log", null, entry);
    }

    public get isQuiet(): boolean {
        const quietArg = getEnvOrArgCLI(["QUIET", "quiet", "q"], "boolean");
        return Boolean(quietArg);
    }

    public getBreadcrumbs(): Breadcrumb[] {
        return this.breadcrumbs;
    }

    public info(
        category: string,
        message: string,
        metadata?: Record<string, any>,
    ): void {
        this.addBreadcrumb(category, "info", message, metadata);
        if (!this.isQuiet) {
            console.log(
                `[${new Date().toISOString()}] [${category}] ${message}`,
            );
        }
    }

    public warn(
        category: string,
        message: string,
        metadata?: Record<string, any>,
    ): void {
        this.addBreadcrumb(category, "warn", message, metadata);
        if (!this.isQuiet) {
            console.warn(
                `[${new Date().toISOString()}] [${category}] ${message}`,
            );
        }
    }

    public error(
        category: string | null,
        message: string | Error,
        ...args: any[]
    ): void {
        const isQuiet = this.isQuiet;

        const errorEntry: Breadcrumb = {
            timestamp: new Date().toISOString(),
            category: category || "Error",
            level: "error",
            message:
                typeof message === "string"
                    ? message
                    : message?.message || String(message),
            metadata: args.length > 0 ? { args } : undefined,
        };
        executeHook("log", null, errorEntry);

        // Filter breadcrumbs by category (or dump all if category is null/falsy)
        const relevant = category
            ? this.breadcrumbs.filter((b) => b.category === category)
            : this.breadcrumbs;

        if (!isQuiet) {
            console.error(
                `[${new Date().toISOString()}] --- BREADCRUMBS DUMP (${category || "ALL CATEGORIES"}) ---`,
            );
            relevant.forEach((b) =>
                console.error(
                    `[${b.timestamp}] [${b.category}] [${b.level.toUpperCase()}]: ${b.message}`,
                ),
            );
            console.error(
                `[${new Date().toISOString()}] --- ERROR DETAILS ---`,
            );
            console.error(message, ...args);
        }
    }
}

export const logger = new Logger();
