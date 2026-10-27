export interface RankableModel {
  id: string;
  label: string;
  provider?: string | undefined;
  aliases?: readonly string[] | undefined;
}

const FIELD_WEIGHT = { id: 0, label: 1, provider: 2, alias: 3 } as const;

interface SearchField {
  value: string;
  weight: number;
}

interface Ranked<T> {
  item: T;
  tier: number;
  weight: number;
  index: number;
}

export function normalizeModelText(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function compactModelText(value: string): string {
  return normalizeModelText(value).replace(/\s+/gu, "");
}

function isSubsequence(needle: string, haystack: string): boolean {
  if (needle === "") return true;
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

function tierOf(
  field: SearchField,
  rawQuery: string,
  normalizedQuery: string,
  compactQuery: string,
  queryTokens: readonly string[],
): number | null {
  const compact = compactModelText(field.value);
  if (compact === "") return null;
  if (field.weight === FIELD_WEIGHT.id && field.value.trim() === rawQuery) return 0;
  if (compact === compactQuery) return 1;
  const normalized = normalizeModelText(field.value);
  if (normalized.startsWith(normalizedQuery)) return 2;
  const tokens = normalized.split(" ").filter((token) => token !== "");
  if (queryTokens.every((query) => tokens.some((token) => token.startsWith(query)))) return 2;
  if (isSubsequence(compactQuery, compact)) return 3;
  return null;
}

function bestMatch(
  item: RankableModel,
  rawQuery: string,
  normalizedQuery: string,
  compactQuery: string,
  queryTokens: readonly string[],
): { tier: number; weight: number } | null {
  const fields: SearchField[] = [
    { value: item.id, weight: FIELD_WEIGHT.id },
    { value: item.label, weight: FIELD_WEIGHT.label },
  ];
  if (item.provider !== undefined) {
    fields.push({ value: item.provider, weight: FIELD_WEIGHT.provider });
  }
  for (const alias of item.aliases ?? []) {
    fields.push({ value: alias, weight: FIELD_WEIGHT.alias });
  }
  let best: { tier: number; weight: number } | null = null;
  for (const field of fields) {
    const tier = tierOf(field, rawQuery, normalizedQuery, compactQuery, queryTokens);
    if (tier === null) continue;
    if (best === null || tier < best.tier || (tier === best.tier && field.weight < best.weight)) {
      best = { tier, weight: field.weight };
    }
  }
  return best;
}

export function rankModels<T extends RankableModel>(
  items: readonly T[],
  query: string,
): readonly T[] {
  const rawQuery = query.trim();
  if (rawQuery === "") return items.slice();
  const normalizedQuery = normalizeModelText(rawQuery);
  const compactQuery = compactModelText(rawQuery);
  if (compactQuery === "") return items.slice();
  const queryTokens = normalizedQuery.split(" ").filter((token) => token !== "");

  const ranked: Ranked<T>[] = [];
  items.forEach((item, index) => {
    const match = bestMatch(item, rawQuery, normalizedQuery, compactQuery, queryTokens);
    if (match === null) return;
    ranked.push({ item, tier: match.tier, weight: match.weight, index });
  });
  ranked.sort(
    (left, right) =>
      left.tier - right.tier || left.weight - right.weight || left.index - right.index,
  );
  return ranked.map((entry) => entry.item);
}
