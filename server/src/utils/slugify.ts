export function slugify(key: string): string {
    return (
        key
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9_-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .replace(/--+/g, "-") || "file"
    );
}
