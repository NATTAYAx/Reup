// ─── schemaFile.ts — how schema.sql is cut into statements ───────────────────
//
// One copy of a rule that had three.
//
// The rule is that statements in schema.sql are separated by a line containing
// only `-- @@`, never by semicolons, because a trigger body has semicolons
// inside it and splitting on those cuts triggers in half. Comment lines are
// dropped on the way out, so nothing downstream has to know what a comment
// looks like.
//
// It was written out longhand in check-sync, again in gen-store-vectors, and a
// third time in Kotlin. Three copies of one rule is the shape of every bug this
// project has spent a month removing, and two of the three now call this.
//
// The Kotlin copy stays where it is on purpose: it is the other side of a
// language boundary, and the vectors are what hold the two together.
export function schemaStatements(text: string): string[] {
  return text
    .split(/^[ \t]*--[ \t]*@@[ \t]*$/m)
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((chunk) => chunk.length > 0);
}

/**
 * Whether an error from running one of those statements is the ordinary one.
 *
 * schema.sql carries the ALTERs that migrated an existing database as well as
 * the CREATEs that build a new one, and every launch runs the whole file. On a
 * database that already has the column, the ALTER throws. That is the normal
 * path and not a fault; anything else is.
 */
export function isAlreadyThere(e: unknown): boolean {
  return String(e).includes("duplicate column");
}