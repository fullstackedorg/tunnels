import type { Item, QueryContext, WhereCondition } from "./interface.ts";

export function getItemValue(item: Item, col: string): any {
    if (col.startsWith("metadata.")) {
        const key = col.slice(9);
        return item.metadata?.[key];
    }
    return item[col];
}

export function matchesCondition(item: Item, cond: WhereCondition): boolean {
    const val = getItemValue(item, cond.column);
    const op = cond.operator || "eq";

    if (op === "eq") {
        if (cond.column === "internalPort") {
            return Number(val) === Number(cond.value);
        }
        if (cond.column.startsWith("metadata.")) {
            return val !== undefined && String(val) === String(cond.value);
        }
        return val === cond.value;
    }
    if (op === "neq") {
        if (val === null || val === undefined) return false;
        if (cond.column === "internalPort") {
            return Number(val) !== Number(cond.value);
        }
        if (cond.column.startsWith("metadata.")) {
            return String(val) !== String(cond.value);
        }
        return val !== cond.value;
    }
    if (op === "in") {
        if (!Array.isArray(cond.value)) return false;
        if (cond.column === "internalPort") {
            return cond.value.some((v) => Number(v) === Number(val));
        }
        if (cond.column.startsWith("metadata.")) {
            return cond.value.some((v) => String(v) === String(val));
        }
        return cond.value.includes(val);
    }
    if (op === "like") {
        if (val === null || val === undefined) return false;
        const needle = String(cond.value).toLowerCase();
        const haystack = String(val).toLowerCase();
        return haystack.includes(needle);
    }
    return false;
}

export function filterItems(items: Item[], where?: WhereCondition[]): Item[] {
    if (!where || where.length === 0) return [...items];
    return items.filter((item) => where.every((cond) => matchesCondition(item, cond)));
}

export function sortAndPaginate(
    items: Item[],
    query?: QueryContext
): { items: Item[]; total: number } {
    const total = items.length;
    let result = [...items];

    {
        const { column, direction } = query?.orderBy ?? { column: "id", direction: "asc" };
        result.sort((a, b) => {
            const valA = getItemValue(a, column) ?? "";
            const valB = getItemValue(b, column) ?? "";
            if (valA < valB) return direction === "desc" ? 1 : -1;
            if (valA > valB) return direction === "desc" ? -1 : 1;
            return 0;
        });
    }

    const offset = Math.max(0, query?.offset ?? 0);
    const limit = Math.min(1000, Math.max(0, query?.limit ?? 100));
    result = result.slice(offset, offset + limit);

    return { items: result, total };
}
