export interface OccupationConcept {
  id: string;
  label: string;
}

interface TaxonomyCandidate {
  id: string;
  label: string;
}

const AUTOCOMPLETE_URL =
  "https://taxonomy.api.jobtechdev.se/v1/taxonomy/suggesters/autocomplete";

export async function resolveOccupationConcept(
  query: string,
  fetcher: typeof fetch = fetch,
): Promise<OccupationConcept | null> {
  const normalizedQuery = normalizeOccupationText(query);
  if (!normalizedQuery) return null;

  const url = new URL(AUTOCOMPLETE_URL);
  url.searchParams.set("query-string", query.trim());
  url.searchParams.set("type", "occupation-name");
  url.searchParams.set("limit", "10");

  const response = await fetcher(url.toString(), {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `JobTech Taxonomy autocomplete failed with HTTP ${response.status}.`,
    );
  }

  const payload: unknown = await response.json();
  const candidates = extractCandidates(payload);
  return chooseOccupationCandidate(query, candidates);
}

export function chooseOccupationCandidate(
  query: string,
  candidates: TaxonomyCandidate[],
): OccupationConcept | null {
  const queryNormalized = normalizeOccupationText(query);
  if (!queryNormalized || candidates.length === 0) return null;

  const exact = candidates.filter(
    (candidate) => normalizeOccupationText(candidate.label) === queryNormalized,
  );
  if (exact.length === 1) return exact[0];

  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: tokenSimilarity(queryNormalized, normalizeOccupationText(candidate.label)),
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.score < 0.5) return null;
  if (second && best.score - second.score < 0.15) return null;
  return best.candidate;
}

export function normalizeOccupationText(value: string): string {
  return value
    .toLocaleLowerCase("sv-SE")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9åäö]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function extractCandidates(payload: unknown): TaxonomyCandidate[] {
  const values = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload) && Array.isArray(payload.results)
        ? payload.results
        : [];

  const output: TaxonomyCandidate[] = [];
  for (const value of values) {
    if (!isRecord(value)) continue;
    const id = stringValue(value["taxonomy/id"] ?? value.id);
    const label = stringValue(
      value["taxonomy/preferred-label"] ??
        value.preferred_label ??
        value.label,
    );
    const type = stringValue(value["taxonomy/type"] ?? value.type);
    if (!id || !label) continue;
    if (type && type !== "occupation-name") continue;
    output.push({ id, label });
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
