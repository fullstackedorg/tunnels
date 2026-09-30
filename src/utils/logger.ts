export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "text" | "json";

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    category: string;
    message: string;
    meta?: Record<string, any>;
    worker: string;
    reqId?: string;
}

const LEVEL_SEVERITY: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

let currentLogLevel: LogLevel = "info";
let currentLogFormat: LogFormat = "text";
let workerIdentity = "1:1";
const ringBuffer: LogEntry[] = [];
const MAX_BREADCRUMBS = 100;
let inLogHook = false;

// Hook dispatcher reference (avoid circular import with hooks.ts)
type LogHookDispatcher = (entry: LogEntry) => void;
let logHookDispatcher: LogHookDispatcher | null = null;

export function setLogHookDispatcher(dispatcher: LogHookDispatcher | null): void {
    logHookDispatcher = dispatcher;
}

export function setLogLevel(level: LogLevel): void {
    currentLogLevel = level;
}

export function setLogFormat(format: LogFormat): void {
    currentLogFormat = format;
}

export function setWorkerIdentity(identity: string): void {
    workerIdentity = identity;
}

export function getWorkerIdentity(): string {
    return workerIdentity;
}

export function getBreadcrumbs(): LogEntry[] {
    return [...ringBuffer];
}

export function clearBreadcrumbs(): void {
    ringBuffer.length = 0;
}

function addToRingBuffer(entry: LogEntry): void {
    ringBuffer.push(entry);
    if (ringBuffer.length > MAX_BREADCRUMBS) {
        ringBuffer.shift();
    }
}

function formatErrorMeta(meta?: Record<string, any>): Record<string, any> | undefined {
    if (!meta) return undefined;
    const clean: Record<string, any> = { ...meta };
    if (clean.error instanceof Error) {
        clean.error = {
            message: clean.error.message,
            stack: clean.error.stack,
            name: clean.error.name,
        };
    }
    return clean;
}

function formatText(entry: LogEntry): string {
    const metaStr =
        entry.meta && Object.keys(entry.meta).length > 0 ? " " + JSON.stringify(entry.meta) : "";
    return `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.category}] ${entry.message}${metaStr}\n`;
}

function formatJson(entry: LogEntry): string {
    return JSON.stringify(entry) + "\n";
}

function writeEntry(entry: LogEntry): void {
    const output = currentLogFormat === "json" ? formatJson(entry) : formatText(entry);
    if (entry.level === "warn" || entry.level === "error") {
        process.stderr.write(output);
    } else {
        process.stdout.write(output);
    }
}

function dumpBreadcrumbs(): void {
    process.stderr.write(`--- Begin Breadcrumbs (${ringBuffer.length} entries) ---\n`);
    for (const entry of ringBuffer) {
        process.stderr.write(currentLogFormat === "json" ? formatJson(entry) : formatText(entry));
    }
    process.stderr.write("--- End Breadcrumbs ---\n");
}

function logMessage(
    level: LogLevel,
    category: string,
    message: string,
    meta?: Record<string, any>
): void {
    const formattedMeta = formatErrorMeta(meta);
    const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level,
        category,
        message,
        meta: formattedMeta,
        worker: workerIdentity,
        reqId: meta?.reqId,
    };

    addToRingBuffer(entry);

    if (LEVEL_SEVERITY[level] < LEVEL_SEVERITY[currentLogLevel]) {
        return;
    }

    if (level === "error") {
        dumpBreadcrumbs();
    }

    writeEntry(entry);

    if (!inLogHook && logHookDispatcher) {
        inLogHook = true;
        try {
            logHookDispatcher(entry);
        } catch {
            // fail-open
        } finally {
            inLogHook = false;
        }
    }
}

export const logger = {
    debug(category: string, message: string, meta?: Record<string, any>): void {
        logMessage("debug", category, message, meta);
    },
    info(category: string, message: string, meta?: Record<string, any>): void {
        logMessage("info", category, message, meta);
    },
    warn(category: string, message: string, meta?: Record<string, any>): void {
        logMessage("warn", category, message, meta);
    },
    error(
        category: string,
        message: string,
        meta?: Record<string, any> & { error?: unknown }
    ): void {
        logMessage("error", category, message, meta);
    },
    setLogLevel,
    setLogFormat,
    setWorkerIdentity,
    getWorkerIdentity,
    getBreadcrumbs,
    clearBreadcrumbs,
    setLogHookDispatcher,
};
