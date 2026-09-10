import { getEnvOrArgCLI } from "./args.ts";

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
        this.breadcrumbs.push({
            timestamp: new Date().toISOString(),
            category,
            level,
            message,
            metadata,
        });
        if (this.breadcrumbs.length > this.maxBreadcrumbs) {
            this.breadcrumbs.shift();
        }
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
