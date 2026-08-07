// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
/** Projects a legacy persona name into the bounded modern wire field. */
export function projectLegacyPersonaDisplayName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("legacy persona display name is malformed");
  }
  for (const source of [value, value.trimStart()]) {
    let projected = "";
    for (let index = 0; index < source.length;) {
      const first = source.charCodeAt(index);
      let width = 1;
      if (first >= 0xd800 && first <= 0xdbff) {
        const second = source.charCodeAt(index + 1);
        if (!(second >= 0xdc00 && second <= 0xdfff)) {
          throw new Error("legacy persona display name is malformed");
        }
        width = 2;
      } else if (first >= 0xdc00 && first <= 0xdfff) {
        throw new Error("legacy persona display name is malformed");
      }
      if (projected.length + width > 200) break;
      projected += source.slice(index, index + width);
      index += width;
    }
    if (projected.trim().length > 0) return projected;
  }
  throw new Error("legacy persona display name is malformed");
}
