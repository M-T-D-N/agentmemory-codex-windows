export const GRAPH_EXTRACTION_SYSTEM = `You are a knowledge graph extraction engine. Given a compressed observation from a coding session, extract entities and relationships.

Output format (XML):
<entities>
  <entity key="n1" type="file|function|concept|error|decision|pattern|library|person|project|preference|location|organization|event" name="exact name" source_observation_ids="obs_id,obs_id">
    <property key="key">value</property>
  </entity>
</entities>
<relationships>
  <relationship type="uses|imports|modifies|causes|fixes|depends_on|related_to|works_at|prefers|blocked_by|caused_by|optimizes_for|rejected|avoids|located_in|succeeded_by" source="n1" target="n2" source_observation_ids="obs_id,obs_id" weight="0.1-1.0"/>
</relationships>

Rules:
- Extract concrete entities only (real file paths, function names, library names)
- Use the most specific type available
- Every entity and relationship must cite one or more observation IDs from the input
- Relationship source and target must reference entity keys from the same response
- Weight relationships by how strong/direct the connection is
- If no entities found, output empty tags`;

export function buildGraphExtractionPrompt(
  observations: Array<{
    id: string;
    title: string;
    narrative: string;
    concepts: string[];
    files: string[];
    type: string;
  }>,
): string {
  const items = observations
    .map(
      (o, i) =>
        `[${i + 1}] Observation ID: ${o.id}\nType: ${o.type}\nTitle: ${o.title}\nNarrative: ${o.narrative}\nConcepts: ${(o.concepts ?? []).join(", ")}\nFiles: ${(o.files ?? []).join(", ")}`,
    )
    .join("\n\n");
  // Some local models default to a hidden reasoning pass that consumes
  // most of the token budget before any output. The suffix is their
  // documented soft switch to skip it; other models ignore the token.
  const noThink = process.env.AGENTMEMORY_LLM_NOTHINK === "1" ? "\n/no_think" : "";
  return `Extract entities and relationships from these observations:\n\n${items}${noThink}`;
}
