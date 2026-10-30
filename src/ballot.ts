export interface Ballot {
  categories: { name: string; nominees: { name: string }[] }[];
}

const MAX_NAME_LENGTH = 200;

export function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : null;
}

/**
 * Accepts {"categories": [{"name": "...", "nominees": ["A", {"name": "B"}]}]}.
 * Returns the normalized ballot, or an error message naming the first problem.
 */
export function parseBallot(input: unknown): Ballot | string {
  const raw = (input as { categories?: unknown } | null)?.categories;
  if (!Array.isArray(raw) || raw.length === 0) return 'Expected a non-empty "categories" array.';

  const seenCategories = new Set<string>();
  const categories: Ballot["categories"] = [];
  for (const [i, category] of raw.entries()) {
    const name = cleanName((category as { name?: unknown } | null)?.name);
    if (!name) return `Category ${i + 1} needs a "name" of 1-${MAX_NAME_LENGTH} characters.`;
    if (seenCategories.has(name.toLowerCase())) return `Category "${name}" appears twice.`;
    seenCategories.add(name.toLowerCase());

    const rawNominees = (category as { nominees?: unknown }).nominees ?? [];
    if (!Array.isArray(rawNominees)) return `Category "${name}": "nominees" must be an array.`;

    const seenNominees = new Set<string>();
    const nominees: { name: string }[] = [];
    for (const [j, nominee] of rawNominees.entries()) {
      const nomineeName = cleanName(typeof nominee === "string" ? nominee : (nominee as { name?: unknown } | null)?.name);
      if (!nomineeName) return `Category "${name}": nominee ${j + 1} needs a name.`;
      if (seenNominees.has(nomineeName.toLowerCase())) return `Category "${name}": nominee "${nomineeName}" appears twice.`;
      seenNominees.add(nomineeName.toLowerCase());
      nominees.push({ name: nomineeName });
    }
    categories.push({ name, nominees });
  }
  return { categories };
}
