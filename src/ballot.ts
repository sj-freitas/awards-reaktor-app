export interface Ballot {
  allowedEmails: string[];
  categories: { name: string; nominees: { name: string; pictureUrl: string | null }[] }[];
}

const MAX_NAME_LENGTH = 200;
export const MAX_NOMINEES = 6;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : null;
}

/** Only https, because the app is served over https and browsers block anything else. */
export function cleanPictureUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Accepts {
 *   "allowedEmails": ["a@example.com"],
 *   "categories": [{"name": "...", "nominees": ["A", {"name": "B", "pictureUrl": "https://..."}]}]
 * }.
 * Returns the normalized ballot, or an error message naming the first problem.
 */
export function parseBallot(input: unknown): Ballot | string {
  const rawEmails = (input as { allowedEmails?: unknown } | null)?.allowedEmails;
  if (!Array.isArray(rawEmails) || rawEmails.length === 0) return 'Expected a non-empty "allowedEmails" array.';
  const allowedEmails = new Set<string>();
  for (const email of rawEmails) {
    if (typeof email !== "string" || !EMAIL.test(email.trim())) return `"${email}" isn't a valid email address.`;
    allowedEmails.add(email.trim().toLowerCase());
  }

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
    if (rawNominees.length > MAX_NOMINEES) {
      return `Category "${name}" has ${rawNominees.length} nominees. The maximum is ${MAX_NOMINEES}.`;
    }

    const seenNominees = new Set<string>();
    const nominees: Ballot["categories"][number]["nominees"] = [];
    for (const [j, nominee] of rawNominees.entries()) {
      const fields = typeof nominee === "string" ? { name: nominee } : ((nominee ?? {}) as { name?: unknown; pictureUrl?: unknown });
      const nomineeName = cleanName(fields.name);
      if (!nomineeName) return `Category "${name}": nominee ${j + 1} needs a name.`;
      if (seenNominees.has(nomineeName.toLowerCase())) return `Category "${name}": nominee "${nomineeName}" appears twice.`;
      seenNominees.add(nomineeName.toLowerCase());
      const rawPicture = (fields as { pictureUrl?: unknown }).pictureUrl;
      const pictureUrl = cleanPictureUrl(rawPicture);
      if (rawPicture != null && !pictureUrl) return `Category "${name}": nominee "${nomineeName}" needs an https "pictureUrl".`;
      nominees.push({ name: nomineeName, pictureUrl });
    }
    categories.push({ name, nominees });
  }
  return { allowedEmails: [...allowedEmails], categories };
}
