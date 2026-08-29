// AgentMemory's established lightweight text-budget approximation. Keep one
// implementation so context injection and working memory cannot drift.
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
