/**
 * Safe SQL identifiers. Table/schema names can't be query parameters, so they
 * are validated against a strict pattern and then double-quoted.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function qualifiedName(schema, table) {
  for (const name of [schema, table]) {
    if (!IDENTIFIER.test(name)) {
      throw new Error(`Invalid SQL identifier: "${name}" (use letters, digits and underscores)`);
    }
  }
  return `"${schema}"."${table}"`;
}