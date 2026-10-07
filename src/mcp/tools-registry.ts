export type McpToolDef = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
};

export const CORE_TOOLS: McpToolDef[] = [
  {
    name: "memory_archive",
    description: "Inspect/list reversible archive state, review current retention/TTL candidates, or preview/apply archive and restore in an exact project. Originals, IDs and provenance remain in canonical storage. Default action is inspect; archive/restore default to dry-run. Apply requires the preview revision, digest and a reason. Candidate listing is read-only and requires individual review. This does not enable automatic retention or perform forget.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Exact registered project; wildcard is rejected" },
        action: { type: "string", enum: ["inspect", "list", "candidates", "archive", "restore"], description: "Operation (default inspect)" },
        target: { type: "object", description: "Required except for list/candidates; observation also requires sessionId", additionalProperties: false,
          properties: { kind: { type: "string", enum: ["memory", "semantic", "procedural", "lesson", "observation", "session", "graph_node", "graph_edge"] },
            id: { type: "string" }, sessionId: { type: "string" } }, required: ["kind", "id"] },
        state: { type: "string", enum: ["archived", "restored", "all"], description: "List filter (default archived)" },
        policy: { type: "string", enum: ["all", "retention", "ttl"], description: "Candidate policy (default all); current data only" },
        threshold: { type: "number", minimum: 0, maximum: 1, description: "Candidate retention threshold (default 0.15); fresh default-decay scores" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "List page size (default 20)" },
        offset: { type: "integer", minimum: 0, description: "List offset (default 0)" },
        dryRun: { type: "boolean", description: "Archive/restore preview defaults to true" },
        expectedRevision: { type: "integer", minimum: 0, description: "Required for apply; from preview" },
        expectedDigest: { type: "string", description: "Required for apply; from preview" },
        reason: { type: "string", description: "Required for apply; why this lifecycle change is appropriate" },
      },
      required: ["project"],
    },
  },
  {
    name: "memory_recall",
    description:
      "Search project-scoped observations and durable memories before continuing work or checking earlier decisions. Returns ranked results in full or compact form, or narrative text; token_budget can truncate the response. sourceKind filters original user or assistant observations. Use '*' only for deliberate cross-project discovery. Returned items record retention access by default; set trackAccess=false for analysis. Use memory_smart_search for compact search followed by ID expansion.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (keywords, file names, concepts)",
        },
        sourceKind: {
          type: "string",
          enum: ["user", "assistant"],
          description: "Filter original observations by speaker before ranking limits. Omit for all sources, including derived memories.",
        },
        agentId: {
          type: "string", minLength: 1, maxLength: 512,
          description: "Optional agent ID; omit to preserve the configured scope, or pass '*' for a deliberate cross-agent read",
        },
        project: {
          type: "string",
          description:
            "Exact registered project identifier, or '*' for a deliberate cross-project read",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 10)",
        },
        format: {
          type: "string",
          description: "Result format: full, compact, or narrative (default full)",
        },
        token_budget: {
          type: "number",
          description: "Optional token budget to trim returned results",
        },
        trackAccess: {
          type: "boolean",
          description:
            "Set to false for analytical reads that must not reinforce access-based retention (default true)",
        },
      },
      required: ["query", "project"],
    },
  },
  {
    name: "memory_compress_file",
    description:
      "Shorten prose in an existing .md file using the configured LLM, validating that headings, URLs and fenced code blocks survive. Requires an enabled LLM provider; noop mode returns disabled. Rejects symlinks and sensitive-looking paths. After validation, writes a sibling backup, normally .original.md (overwriting an existing backup), and replaces the source. Returns source/backup paths and character counts, or a validation/error result. Use for file compression, not durable memory consolidation.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Path to the markdown file to compress",
        },
      },
      required: ["filePath"],
    },
  },
  {
    name: "memory_save",
    description:
      "Persist a verified insight, decision or preference in an exact project; '*' is rejected for writes. Optional sourceObservationIds must resolve to official observations in that project. Similar content may supersede an existing memory, so repeated calls can create new versions. Returns the saved memory and, when present, an advisory similarTo match. Use memory_lesson_save for reusable lessons with confidence and reinforcement.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The insight or decision to remember",
        },
        sourceObservationIds: {
          type: "array",
          maxItems: 500,
          items: { type: "string", minLength: 1 },
          description: "Official observation IDs in the exact project supporting this memory",
        },
        type: {
          type: "string",
          description:
            "Memory type: pattern, preference, architecture, bug, workflow, or fact",
        },
        concepts: {
          type: "string",
          description: "Comma-separated key concepts",
        },
        files: {
          type: "string",
          description: "Comma-separated relevant file paths",
        },
        project: {
          type: "string",
          description:
            "Stable canonical project identifier this memory belongs to (e.g. a slug, " +
            "UUID, or registry key). Must match the value used when the session was " +
            "started. Do not use filesystem paths or ad-hoc display names — those " +
            "change across machines and will silently break project scoping.",
        },
        agentId: {
          type: "string",
          description:
            "Agent identity to scope this memory to. When set, agent-scoped recall " +
            "and search only surface it for the same agentId. Omit for shared memory.",
        },
      },
      required: ["content", "project"],
    },
  },
  {
    name: "memory_file_history",
    description: "Retrieve context for comma-separated file paths before editing or investigating them. Searches up to 15 recent visible sessions and includes up to five important observations per file; sessionId excludes the current session. Omit project or use '*' to search across projects. Returns a context string containing an agentmemory-file-context block, or an empty string. Matching observations record retention access; use memory_recall for general topic searches.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Exact project; use wildcard for all projects" },
        agentId: { type: "string", minLength: 1, maxLength: 512, description: "Optional agent ID; omit for configured scope, or use '*' for a deliberate cross-agent read" },
        files: { type: "string", description: "Comma-separated file paths" },
        sessionId: {
          type: "string",
          description: "Current session ID to exclude",
        },
      },
      required: ["files"],
    },
  },
  {
    name: "memory_patterns",
    description: "Detect repeated file co-changes and error titles in visible, non-archived session observations without an LLM. File pairs need at least three sessions; error titles need at least two occurrences. Returns up to 20 frequency-ranked patterns with type, description, files, frequency and source session IDs. Omit project or use '*' for all projects; agentId preserves the configured read scope. Use memory_profile for a project overview or memory_reflect to create synthesized insights.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", minLength: 1, maxLength: 512, description: "Optional agent ID; omit for configured scope, or use '*' for a deliberate cross-agent read" },
        project: { type: "string", description: "Project path to analyze" },
      },
    },
  },
  {
    name: "memory_sessions",
    description:
      "Read stored session metadata in an explicit project, newest startedAt first. Returns {sessions,total,limit,offset,nextOffset}; no matches returns an empty sessions array and nextOffset:null. limit defaults to 20 (max 500); follow nextOffset with offset to continue. sessionId selects one session; agentId defaults to configured read scope and '*' reads across agents. project:'*' permits a deliberate cross-project read. Archived and excluded ambient sessions are hidden; includeExcluded:true requires exact project and sessionId and still hides archived sessions. Invalid filters return an error. Use memory_timeline for observations within a session.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Exact project, or '*' for deliberate cross-project reads" },
        sessionId: { type: "string", description: "Optional exact session ID" },
        agentId: { type: "string", description: "Optional agent ID; '*' reads across agents" },
        includeExcluded: { type: "boolean", description: "Inspect an excluded session; requires exact project and sessionId" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 20 },
        offset: { type: "integer", minimum: 0, default: 0 },
      },
      required: ["project"],
    },
  },
  {
    name: "memory_smart_search",
    description:
      "Search an explicit project with hybrid keyword/semantic ranking, returning compact results with observation IDs for progressive disclosure. Supply comma-separated expandIds to retrieve up to 20 full observations; expansion takes precedence over query and reports truncation. Use '*' only for deliberate cross-project reads. Search and expansion record retention access unless trackAccess=false. Use memory_recall when you need full, compact or narrative results in one call.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query; optional when expanding observation IDs" },
        agentId: {
          type: "string", minLength: 1, maxLength: 512,
          description: "Optional agent ID for search and expansion; omit to preserve the configured scope, or pass '*' for a deliberate cross-agent read",
        },
        project: {
          type: "string",
          description:
            "Exact registered project identifier, or '*' for a deliberate cross-project read",
        },
        expandIds: {
          type: "string",
          description: "Comma-separated observation IDs to expand",
        },
        limit: { type: "number", description: "Max results (default 10)" },
        trackAccess: {
          type: "boolean",
          description:
            "Set to false for analytical reads that must not reinforce access-based retention (default true)",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "memory_vision_search",
    description:
      "Find stored image embeddings by text description or image similarity. Requires AGENTMEMORY_IMAGE_EMBEDDINGS=true and its image provider. Supply queryText, queryImageBase64 or queryImageRef; precedence is text, base64, then file reference. File references must be registered under the managed image store. Returns similarity-ranked image references with scores and session/observation IDs, plus total candidates; sessionId narrows scope. Use memory_smart_search for textual observations.",
    inputSchema: {
      type: "object",
      properties: {
        queryText: { type: "string", description: "Text query (e.g. 'login form with error banner')" },
        queryImageRef: { type: "string", description: "Absolute path to a stored image to match against" },
        queryImageBase64: { type: "string", description: "Raw base64 image bytes or data URL" },
        topK: { type: "number", description: "Max results (default 10, max 50)" },
        sessionId: { type: "string", description: "Filter to a single session" },
      },
    },
  },
  {
    name: "memory_timeline",
    description: "Retrieve a chronological observation window around an ISO timestamp or keyword to reconstruct nearby activity. before and after define the full window; follow nextOffset with offset until null. Returns observations and pagination metadata, bounded to 100 entries and 2 MiB per page. Omitted project searches all projects; specify an exact project to narrow it. Records retention access unless trackAccess=false. Use memory_smart_search for relevance-ranked discovery.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", minLength: 1, maxLength: 512, description: "Optional agent ID; omit for configured scope, or use '*' for a deliberate cross-agent read" },
        anchor: {
          type: "string",
          description: "Anchor point: ISO date or keyword",
        },
        project: { type: "string", description: "Exact project path; use '*' for all projects. Omission keeps the existing all-project scope." },
        before: {
          type: "integer", minimum: 0,
          description: "Full-window observations before anchor (default 5; zero is valid)",
        },
        after: {
          type: "integer", minimum: 0,
          description: "Full-window observations after anchor (default 5; zero is valid)",
        },
        offset: {
          type: "integer", minimum: 0,
          description: "Offset within the full window (default 0); continue at nextOffset until null",
        },
        trackAccess: {
          type: "boolean",
          description:
            "Set to false for analytical reads that must not reinforce access-based retention (default true)",
        },
      },
      required: ["anchor"],
    },
  },
  {
    name: "memory_profile",
    description: "Get a project overview from its 20 most recent visible sessions: top concepts/files, conventions, errors and recent activity. Returns {profile,cached}, or {profile:null,reason:'no_sessions'}. A current cache is reused for up to one hour; refresh='true' forces recomputation. Recomputing persists the profile cache and an audit entry. Supply the exact project identifier; agentId preserves configured scope. Use memory_patterns to inspect recurring co-changes or errors.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", minLength: 1, maxLength: 512, description: "Optional agent ID; omit for configured scope, or use '*' for a deliberate cross-agent read" },
        project: { type: "string", description: "Project path" },
        refresh: {
          type: "string",
          description: "Set to 'true' to force rebuild",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "memory_export",
    description: "Return a versioned JSON export of stored AgentMemory data, including sessions, observations, memories, graph and derived collections. Use for backup or transfer; this tool returns data rather than writing an export file. It has no project filter and may expose a large cross-project payload. Oversized responses report a transport-limit error. Use memory_obsidian_export for Markdown files or memory_snapshot_create for a local Git snapshot.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_relations",
    description: "Follow stored memory-to-memory relations, related IDs, supersession and parent links from memoryId. Returns confidence-ranked results containing memory, hop and confidence; the starting memory is excluded. maxHops defaults to two and is capped at five, with at most 500 visited memories. Returned memories record retention access. Use memory_graph_query for the separate entity/concept graph rather than memory relationships.",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: {
          type: "string",
          description: "Memory ID to find relations for",
        },
        maxHops: {
          type: "number",
          description: "Max traversal depth (default 2)",
        },
        minConfidence: {
          type: "number",
          description: "Min confidence (0-1, default 0)",
        },
      },
      required: ["memoryId"],
    },
  },
  {
    name: "memory_commit_lookup",
    description:
      "Read the stored commit/session link for one full git commit SHA. Returns {commit,sessions}, where commit contains recorded metadata and visible sessionIds, and sessions contains their stored session records. Missing or excluded ambient sessions are omitted. An unrecorded SHA returns {commit:null,sessions:[]}; a missing or empty sha returns an error. This read does not scan Git repositories or prove who authored a commit. Use memory_commits to discover recorded links by branch or remote repo URL, or memory_timeline to read a linked session's observations.",
    inputSchema: {
      type: "object",
      properties: {
        sha: { type: "string", description: "Full git commit SHA" },
      },
      required: ["sha"],
    },
  },
  {
    name: "memory_commits",
    description:
      "List recorded Git commit/session links, newest linkedAt first, with optional exact branch and remote repo URL filters. Returns {commits}; limit defaults to 100 and is capped at 500. Excluded ambient sessions are removed from session links. This queries stored links rather than scanning Git repositories. Use memory_commit_lookup when you already know a commit SHA.",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Filter by branch name" },
        repo: { type: "string", description: "Filter by remote URL" },
        limit: { type: "number", description: "Max results (default 100, max 500)" },
      },
    },
  },
];

export const V040_TOOLS: McpToolDef[] = [
  {
    name: "memory_claude_bridge_sync",
    description:
      "Exchange data with the configured Claude Code MEMORY.md bridge. direction='read' reads and parses the file, storing a last-read snapshot and audit entry; it does not create durable memories. direction='write' overwrites MEMORY.md with visible latest memories under the configured line budget and returns its path and line count. Requires an enabled bridge and configured file path. Use memory_export for a complete JSON backup.",
    inputSchema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          description:
            "'read' to import from MEMORY.md, 'write' to export to MEMORY.md",
        },
      },
      required: ["direction"],
    },
  },
  {
    name: "memory_graph_query",
    description:
      "Read stored entity/concept graph nodes and edges in an explicit project, or '*' for deliberate cross-project reads; no automatic extraction is required. startNodeId selects bounded traversal, while query and nodeType filter nodes. Returns nodes, page-local edges, depth, totals and pagination/truncation metadata. edgeLimit/edgeOffset opt into an independent exact edge inventory page. Inspect warnings and totalsExact before treating totals as complete. Use memory_relations for memory-to-memory links.",
    inputSchema: {
      type: "object",
      properties: {
        startNodeId: {
          type: "string",
          description: "Starting node ID for traversal",
        },
        nodeType: { type: "string", description: "Filter by node type" },
        maxDepth: {
          type: "number",
          description: "Max BFS depth (default 3, max 5)",
        },
        query: { type: "string", description: "Search nodes by name" },
        project: {
          type: "string",
          description:
            "Exact registered project identifier, or '*' for a deliberate cross-project read",
        },
        limit: {
          type: "number",
          description: "Max nodes to return (default 500, max 5000)",
        },
        offset: {
          type: "number",
          description: "Node offset for pagination",
        },
        edgeLimit: {
          type: "number",
          description:
            "Opt in to an independent exact edge inventory page (default 500, max 1000); existing edges remains viewer page-local",
        },
        edgeOffset: {
          type: "number",
          description: "Exact edge inventory offset for pagination",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "memory_graph_upsert",
    description:
      "Create or merge manually authored graph nodes and edges in an exact project without an LLM. Official session/observation sources must belong to that project. Node keys are request-local edge endpoints; sourceIndexes selects supporting source groups, or sharedSources=true explicitly shares all groups. existingNodeId targets one validated live node. Writes provenance and audit records; returns node-key-to-ID mappings and node/edge created/merged counts. Use memory_graph_query to inspect existing graph records first.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          maxLength: 512,
          description: "Exact registered project identifier",
        },
        sources: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          description: "Official source sessions and observations",
          items: {
            type: "object",
            properties: {
              sessionId: {
                type: "string",
                description: "Existing AgentMemory session ID in this project",
              },
              observationIds: {
                type: "array",
                minItems: 1,
                maxItems: 200,
                items: { type: "string" },
                description: "Existing observation IDs from that session",
              },
            },
            required: ["sessionId", "observationIds"],
          },
        },
        sharedSources: {
          type: "boolean",
          description:
            "Explicitly attach every source group to every node and edge. Required when multiple sources intentionally support multiple records and sourceIndexes are omitted.",
        },
        nodes: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          description: "Canonical nodes keyed locally for this request",
          items: {
            type: "object",
            properties: {
              key: { type: "string", maxLength: 128 },
              existingNodeId: {
                type: "string", minLength: 1, maxLength: 128,
                description: "Update only this existing live node after exact project/type/name validation; preserve other same-name nodes",
              },
              type: {
                type: "string",
                enum: [
                  "file", "function", "concept", "error", "decision", "pattern",
                  "library", "person", "project", "preference", "location",
                  "organization", "event",
                ],
              },
              name: { type: "string", maxLength: 512 },
              properties: {
                type: "object",
                maxProperties: 32,
                additionalProperties: { type: "string" },
              },
              sourceIndexes: {
                type: "array",
                minItems: 1,
                maxItems: 50,
                uniqueItems: true,
                items: { type: "integer", minimum: 0 },
                description:
                  "Zero-based indexes into sources that support this node",
              },
            },
            required: ["key", "type", "name"],
          },
        },
        edges: {
          type: "array",
          maxItems: 500,
          description: "Relationships between request-local node keys",
          items: {
            type: "object",
            properties: {
              source: { type: "string" },
              target: { type: "string" },
              type: {
                type: "string",
                enum: [
                  "uses", "imports", "modifies", "causes", "fixes", "depends_on",
                  "related_to", "works_at", "prefers", "blocked_by", "caused_by",
                  "optimizes_for", "rejected", "avoids", "located_in", "succeeded_by",
                ],
              },
              weight: { type: "number", minimum: 0, maximum: 1 },
              properties: {
                type: "object",
                maxProperties: 32,
                additionalProperties: { type: "string" },
              },
              sourceIndexes: {
                type: "array",
                minItems: 1,
                maxItems: 50,
                uniqueItems: true,
                items: { type: "integer", minimum: 0 },
                description:
                  "Zero-based indexes into sources that support this edge",
              },
            },
            required: ["source", "target", "type"],
          },
        },
      },
      required: ["project", "sources", "nodes"],
    },
  },
  {
    name: "memory_graph_provenance_reconcile",
    description:
      "Correct exact graph targets in one project with a required audit reason and validated session/observation sources. action defaults to detach: remove selected node/edge source references while retaining a final source observation. retire/restore changes only exact edge visibility, preserves original provenance and edge history, and requires expectedUpdatedAt plus canonical review evidence in sources. restore also requires live same-project endpoints and valid original provenance. dryRun:true previews without mutation; otherwise changed targets update graph/index state and create an audit entry. Returns {success,action,project,dryRun,changedTargets,results} with per-target before/after provenance and removed IDs; applied changes also return auditId. Unchanged targets have changed:false. Invalid, missing, stale, wrong-project or conflicting targets return {success:false,error}. Use memory_graph_query to inspect targets and memory_graph_upsert to add supported relationships; memory_graph_purge physically deletes a project graph.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string", enum: ["detach", "retire", "restore"],
          description: "Default detach removes requested provenance. Retire/restore changes exact edge visibility; target sources are review evidence, not replacement relation support.",
        },
        project: {
          type: "string",
          maxLength: 512,
          description: "Exact registered project identifier",
        },
        targets: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["node", "edge"] },
              id: { type: "string", maxLength: 128 },
              sources: {
                type: "array",
                minItems: 1,
                maxItems: 50,
                items: {
                  type: "object",
                  properties: {
                    sessionId: {
                      type: "string",
                      description: "Existing AgentMemory session ID in this project",
                    },
                    observationIds: {
                      type: "array",
                      minItems: 1,
                      maxItems: 200,
                      items: { type: "string" },
                    },
                  },
                  required: ["sessionId", "observationIds"],
                },
              },
              expectedUpdatedAt: {
                type: "string",
                description:
                  "Optimistic concurrency value from updatedAt or createdAt; required for retire/restore",
              },
            },
            required: ["kind", "id", "sources"],
          },
        },
        reason: {
          type: "string",
          maxLength: 1000,
          description: "Required audit reason for applying the correction",
        },
        dryRun: {
          type: "boolean",
          description: "Preview exact before/after provenance without mutation",
        },
      },
      required: ["project", "targets", "reason"],
    },
  },
  {
    name: "memory_graph_purge",
    description:
      "Irreversibly purge graph records for one exact project with a required audit reason. First obtain the complete live nodeIds/edgeIds inventory using memory_graph_query; a clean snapshot covering at most 500 nodes and 1000 edges across the graph is required. Inventories must match exactly; an empty project, partial/dirty/reset snapshot, changed records or oversized physical project fails with {success:false,error}. There is no dry run. Deletes project nodes including stale rows, incident/project edges, their edge history, indexes and archive metadata; preserves sessions, observations, memories and lessons. Returns {success,project,auditId,nodesDeleted,edgesDeleted,liveNodesDeleted,liveEdgesDeleted,archiveStatesRemoved,nodeIds,edgeIds,remainingNodes,remainingEdges}. Physical counts may exceed supplied live counts. Use memory_graph_provenance_reconcile for selective provenance correction or reversible edge retirement.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          maxLength: 512,
          description: "Exact registered project identifier",
        },
        nodeIds: {
          type: "array",
          maxItems: 500,
          items: { type: "string" },
          description:
            "Exact complete node ID inventory returned for this project",
        },
        edgeIds: {
          type: "array",
          maxItems: 1000,
          items: { type: "string" },
          description:
            "Exact complete live edge ID inventory returned for this project",
        },
        reason: {
          type: "string",
          maxLength: 1000,
          description: "Required audit reason for the destructive purge",
        },
      },
      required: ["project", "nodeIds", "edgeIds", "reason"],
    },
  },
  {
    name: "memory_consolidate",
    description:
      "Run the configured LLM-backed consolidation pipeline, mutating stored semantic/procedural memory, reflection insights and decay strengths with an audit entry. Omit tier for all, or select semantic, reflect, procedural or decay; episodic is not implemented. This tool exposes no project filter. Returns {success:true,results} with per-tier counts, skipped reasons or errors; success:true can include tier failures. Semantic needs at least 5 summaries, procedural at least 2 recurring patterns. Disabled configuration returns {success:false,skipped:true,reason}; the MCP handler reports this or a thrown pipeline failure as unavailable. Optional OBSIDIAN_AUTO_EXPORT also writes an export. Disabled by default in zero-LLM/noop and managed local-qwen modes; use memory_save, memory_lesson_save or memory_graph_upsert for curated writes.",
    inputSchema: {
      type: "object",
      properties: {
        tier: {
          type: "string",
          description: "Target tier: all, semantic, reflect, procedural, or decay; defaults to all when omitted",
        },
      },
    },
  },
  {
    name: "memory_team_share",
    description: "Publish an existing memory or pattern into the configured team's shared feed, returning {success,sharedItem}. Requires TEAM_ID and USER_ID; repeated calls create additional shared items and audit entries. The observation itemType currently fails because its required sessionId is not exposed by this MCP tool. Use memory_team_feed to inspect shared items, and share only content approved for that team.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: {
          type: "string",
          description: "ID of memory or observation to share",
        },
        itemType: {
          type: "string",
          description: "Type: observation, memory, or pattern",
        },
      },
      required: ["itemId", "itemType"],
    },
  },
  {
    name: "memory_team_feed",
    description: "Read the configured team's shared memory, pattern and observation feed, newest sharedAt first. Returns {items,total}; limit bounds returned items (default 20), while total counts all shared entries. Requires TEAM_ID and USER_ID; an unavailable team backend returns a setup message. Use memory_team_share to publish an item; this feed does not retrieve unshared personal memories.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max items (default 20)" },
      },
    },
  },
  {
    name: "memory_audit",
    description: "Inspect recorded memory operations to explain a change or verify its history. Returns audit entries newest first, optionally filtered by exact operation name; limit defaults to 50. Entries include timestamps, affected IDs and operation details. This queries existing audit records rather than checking subsystem health; use memory_diagnose for current consistency checks. Query failures return an error result.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", description: "Filter by operation type" },
        limit: { type: "number", description: "Max entries (default 50)" },
      },
    },
  },
  {
    name: "memory_governance_delete",
    description: "Permanently delete the comma-separated memoryIds and their access/search-index entries, recording an audit reason. Use memory_archive for reversible hiding. Supply the exact project for archived targets; when supplied, every selected existing memory must belong to it. Deleted originals' archive metadata is removed. Returns success, deleted count and requested total, plus archiveStatesRemoved when applicable; missing IDs are skipped. This does not delete sessions or observations.",
    inputSchema: {
      type: "object",
      properties: {
        memoryIds: {
          type: "string",
          description: "Comma-separated memory IDs to delete",
        },
        reason: { type: "string", description: "Reason for deletion" },
        project: { type: "string", description: "Exact project; required for archive targets and enforced for every selected memory when supplied" },
      },
      required: ["memoryIds"],
    },
  },
  {
    name: "memory_snapshot_create",
    description: "Capture current exported memory state in the configured local snapshot directory, write state.json and commit it in that directory's Git repository. Requires Git and writable snapshot storage. Returns snapshot ID, commit hash, timestamp, message and counts, or a successful no-op message for an overlapping/no-change snapshot. This mutates local files and Git state; use memory_export when you only need returned JSON.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Snapshot description" },
      },
    },
  },
];

export const V050_TOOLS: McpToolDef[] = [
  {
    name: "memory_action_create",
    description:
      "Persist a work item and optional dependency edges, returning {success,action,edges}. title is required; parentId and comma-separated requires IDs must name existing actions. Any requires edge creates the action as blocked; otherwise it starts pending. Priority defaults to five and is clamped to 1-10. Each call creates a new action and audit entry. Use memory_action_update for an existing action or memory_routine_run for a stored workflow.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Action title" },
        description: {
          type: "string",
          description: "Detailed description of the work",
        },
        priority: {
          type: "number",
          description: "Priority 1-10 (10 highest)",
        },
        project: { type: "string", description: "Project path" },
        tags: {
          type: "string",
          description: "Comma-separated tags",
        },
        parentId: {
          type: "string",
          description: "Parent action ID for hierarchical actions",
        },
        requires: {
          type: "string",
          description:
            "Comma-separated action IDs that must complete before this",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "memory_action_update",
    description:
      "Change an existing action's status, result or priority, returning the updated action and recording an audit entry. status='done' can return blocked dependents to pending when their required actions are done; this propagation does not recheck checkpoint gates. Missing actions return an error; priority is clamped to 1-10. Use memory_action_create for new work and memory_lease to claim execution rather than merely changing status.",
    inputSchema: {
      type: "object",
      properties: {
        actionId: { type: "string", description: "Action ID to update" },
        status: {
          type: "string",
          description: "New status: pending, active, done, blocked, cancelled",
        },
        result: {
          type: "string",
          description: "Outcome description (when completing)",
        },
        priority: { type: "number", description: "New priority 1-10" },
      },
      required: ["actionId"],
    },
  },
  {
    name: "memory_frontier",
    description:
      "Rank unfinished actions with no detected dependency, checkpoint or active-conflict blockers. Returns frontier items with action, score and lease state, plus totalActions and totalUnblocked; project filters the set. Supply agentId to exclude actions leased by others. This suggests candidates without acquiring leases or changing status. Use memory_next for a single suggestion and memory_lease to claim an action.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Filter by project" },
        agentId: {
          type: "string",
          description: "Agent ID to check lease conflicts",
        },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
  },
  {
    name: "memory_next",
    description:
      "Suggest the highest-ranked action from memory_frontier for the optional project and agentId. Returns suggestion with action ID, title, priority and score plus counts, or suggestion:null when no actionable work is found. Supplying agentId accounts for leases held by other agents. It does not claim the action or start work; use memory_lease to acquire it, or memory_frontier to compare several candidates.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Filter by project" },
        agentId: { type: "string", description: "Current agent ID" },
      },
    },
  },
  {
    name: "memory_lease",
    description:
      "Acquire, renew or release an action lease for agentId. Acquire requires an unfinished, unblocked action and marks it active/assigned; another holder returns a conflict. Renew requires this agent's live lease. Release with a nonempty result marks the assigned action done; otherwise it returns to pending. Release does not propagate dependent completion; use memory_action_update for that transition. Writes lease/action/audit state and returns lease details or released:true.",
    inputSchema: {
      type: "object",
      properties: {
        actionId: { type: "string", description: "Action ID" },
        agentId: { type: "string", description: "Agent claiming the action" },
        operation: {
          type: "string",
          description: "acquire, release, or renew",
        },
        result: {
          type: "string",
          description: "Result when releasing (marks action done)",
        },
        ttlMs: {
          type: "number",
          description: "Lease duration in ms (default 10min, max 1hr)",
        },
      },
      required: ["actionId", "agentId", "operation"],
    },
  },
  {
    name: "memory_routine_run",
    description:
      "Start a new run of an existing routineId, creating an action for each stored workflow step and requires edges between dependent steps. Returns {success,run,actionsCreated}; missing routines return an error. project supplies context for created actions and initiatedBy records the initiator. Each call creates a fresh run and audit entry; it does not execute the work. Use memory_action_create for a single work item.",
    inputSchema: {
      type: "object",
      properties: {
        routineId: { type: "string", description: "Routine template ID" },
        project: { type: "string", description: "Project context" },
        initiatedBy: { type: "string", description: "Agent starting the run" },
      },
      required: ["routineId"],
    },
  },
  {
    name: "memory_signal_send",
    description:
      "Store a typed message for another AgentMemory agent, or broadcast by omitting to, returning {success,signal}. Requires nonempty from and content. replyTo reuses an existing parent signal's thread when found; otherwise a new thread is created. Writes message and audit state. This MCP surface exposes no TTL parameter. Use memory_signal_read to retrieve messages; sending requires authorization for the recipient and content.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Sender agent ID" },
        to: {
          type: "string",
          description: "Recipient agent ID (omit for broadcast)",
        },
        content: { type: "string", description: "Message content" },
        type: {
          type: "string",
          description: "Message type: info, request, response, alert, handoff",
        },
        replyTo: {
          type: "string",
          description: "Signal ID to reply to (auto-threads)",
        },
      },
      required: ["from", "content"],
    },
  },
  {
    name: "memory_signal_read",
    description:
      "Read non-expired signals visible to agentId, newest first, returning {success,signals}. threadId narrows a conversation; unreadOnly='true' selects unread messages addressed directly to this agent, excluding broadcasts. Returned unread direct messages are marked read and audited; sent messages and broadcasts are visible in ordinary reads. limit defaults to 50. Use memory_signal_send to create a message.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent to read messages for" },
        unreadOnly: {
          type: "string",
          description: "Set to 'true' for unread only",
        },
        threadId: {
          type: "string",
          description: "Filter by conversation thread",
        },
        limit: { type: "number", description: "Max messages (default 50)" },
      },
      required: ["agentId"],
    },
  },
  {
    name: "memory_checkpoint",
    description:
      "Manage a recorded external gate rather than performing a CI, approval or deploy check itself. operation='create' requires name and optionally gates existing linkedActionIds; 'resolve' requires checkpointId and passed/failed status. Passing can unblock actions when all requirements/gates are met; resolving a non-pending checkpoint fails. 'list' reads stored checkpoints. Returns checkpoint and unblock count, or a checkpoint list. Create/resolve persist state and audit entries; use sentinels for event-driven conditions.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: "create, resolve, or list",
        },
        name: { type: "string", description: "Checkpoint name (for create)" },
        checkpointId: {
          type: "string",
          description: "Checkpoint ID (for resolve)",
        },
        status: {
          type: "string",
          description: "passed or failed (for resolve)",
        },
        type: {
          type: "string",
          description: "Checkpoint type: ci, approval, deploy, external, timer",
        },
        linkedActionIds: {
          type: "string",
          description:
            "Comma-separated action IDs this checkpoint gates (for create)",
        },
      },
      required: ["operation"],
    },
  },
  {
    name: "memory_mesh_sync",
    description:
      "Exchange configured shared collections with registered peer AgentMemory instances. Requires AGENTMEMORY_SECRET and reachable permitted peer URLs. peerId selects one peer; omission selects all, with direction push, pull or both (default both). Push sends local data; pull merges received records. Updates local peer/audit state and returns per-peer pushed/pulled counts and errors, even when some peers fail. Use only for authorized peer transfers.",
    inputSchema: {
      type: "object",
      properties: {
        peerId: {
          type: "string",
          description: "Specific peer ID (omit for all)",
        },
        direction: {
          type: "string",
          description: "push, pull, or both (default both)",
        },
      },
    },
  },
];

export const V051_TOOLS: McpToolDef[] = [
  {
    name: "memory_sentinel_create",
    description:
      "Persist a watching sentinel and optional gates on existing linkedActionIds. Supply config as JSON: timer needs positive durationMs; threshold needs metric, operator gt/lt/eq and numeric value; pattern needs a pattern string; webhook needs a path. Timers schedule a local callback; other types rely on checks or external triggering. Returns {success,sentinel} and records audit state. Use memory_checkpoint for a manually resolved external gate.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Sentinel name" },
        type: {
          type: "string",
          description: "Type: webhook, timer, threshold, pattern, approval, custom",
        },
        config: {
          type: "string",
          description: "JSON config (timer: {durationMs}, threshold: {metric,operator,value}, pattern: {pattern}, webhook: {path})",
        },
        linkedActionIds: {
          type: "string",
          description: "Comma-separated action IDs to gate",
        },
        expiresInMs: { type: "number", description: "Auto-expire after ms" },
      },
      required: ["name", "type"],
    },
  },
  {
    name: "memory_sentinel_trigger",
    description:
      "Fire an existing watching sentinel by ID, optionally attaching a JSON result payload. Stores triggered status/time, records an audit entry and can return linked blocked actions to pending when their gates pass; this does not recheck required action dependencies. Returns {success,sentinel,unblockedCount}; missing or non-watching sentinels return an error. Use memory_sentinel_create to register a condition or memory_checkpoint to resolve a recorded external check.",
    inputSchema: {
      type: "object",
      properties: {
        sentinelId: { type: "string", description: "Sentinel ID to trigger" },
        result: { type: "string", description: "JSON result payload" },
      },
      required: ["sentinelId"],
    },
  },
  {
    name: "memory_sketch_create",
    description:
      "Create an ephemeral action graph for exploratory work. Auto-expires after TTL. Can be promoted to permanent actions or discarded.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Sketch title" },
        description: { type: "string", description: "What this sketch explores" },
        expiresInMs: { type: "number", description: "TTL in ms (default 1 hour)" },
        project: { type: "string", description: "Project context" },
      },
      required: ["title"],
    },
  },
  {
    name: "memory_sketch_promote",
    description:
      "Promote the existing actions of an active sketchId into regular work items by removing their sketch association; optional project changes their project. Marks the sketch promoted and records audit entries, returning {success,promotedIds}. Missing or non-active sketches fail. An empty sketch promotes no actions. Use after exploratory work is accepted; memory_action_create directly creates regular work items.",
    inputSchema: {
      type: "object",
      properties: {
        sketchId: { type: "string", description: "Sketch ID to promote" },
        project: { type: "string", description: "Override project for promoted actions" },
      },
      required: ["sketchId"],
    },
  },
  {
    name: "memory_crystallize",
    description:
      "Summarize the specified done or cancelled actions and their links using the configured LLM. Stores a crystal digest, attempts to save extracted lessons and links source actions to the crystal; returns {success,crystal}. Missing or unfinished action IDs fail. actionIds is comma-separated; project/sessionId annotate the digest. Use for a completed work chain, not general recall; zero-LLM workflows should save curated lessons directly with memory_lesson_save.",
    inputSchema: {
      type: "object",
      properties: {
        actionIds: {
          type: "string",
          description: "Comma-separated completed action IDs to crystallize",
        },
        project: { type: "string", description: "Project context" },
        sessionId: { type: "string", description: "Session context" },
      },
      required: ["actionIds"],
    },
  },
  {
    name: "memory_diagnose",
    description:
      "Inspect current subsystem consistency, returning {success,checks,summary} with pass/warn/fail and fixable counts. categories is comma-separated; omission checks all supported categories, and unknown names are ignored. Checks cover action dependencies, leases, sentinels, sketches, signals, sessions, memory and derived data, and mesh state. Does not apply repairs. Review the findings before using memory_heal; use memory_audit for historical operations.",
    inputSchema: {
      type: "object",
      properties: {
        categories: {
          type: "string",
          description: "Comma-separated categories to check (default all)",
        },
      },
    },
  },
  {
    name: "memory_heal",
    description:
      "Apply supported repairs for selected diagnostic categories: action dependency state, expired/orphaned leases, sentinels, sketch actions, signals and superseded memories. This can delete orphaned or expired records and changes state with audit entries. dryRun='true' reports proposed fixes without applying them; default applies repairs. Returns {success,fixed,skipped,details}. Run memory_diagnose first and review which issues are fixable; not every diagnostic has an automatic repair.",
    inputSchema: {
      type: "object",
      properties: {
        categories: {
          type: "string",
          description: "Comma-separated categories to heal (default all)",
        },
        dryRun: {
          type: "string",
          description: "Set to 'true' for dry run (report but don't fix)",
        },
      },
    },
  },
  {
    name: "memory_facet_tag",
    description:
      "Store a dimension:value facet on an action, memory or observation ID for later filtering with memory_facet_query. Returns {success,facet}; a matching targetId/dimension/value already present returns skipped:true without adding another facet. dimension and value must be nonempty. This stores categorization metadata and does not update the target's content or status; use memory_action_update to change an action's state.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "ID of the target to tag" },
        targetType: {
          type: "string",
          description: "Type: action, memory, or observation",
        },
        dimension: { type: "string", description: "Tag dimension (e.g., priority, team, status)" },
        value: { type: "string", description: "Tag value (e.g., urgent, backend, reviewed)" },
      },
      required: ["targetId", "targetType", "dimension", "value"],
    },
  },
  {
    name: "memory_facet_query",
    description:
      "Find IDs categorized by stored dimension:value facets. Supply at least one comma-separated matchAll (AND) or matchAny (OR) list; when both are present, both conditions must pass. targetType optionally narrows action, memory or observation matches. Returns up to 50 results with targetId, targetType and matchedFacets, not full target records. Use memory_facet_tag to add facets or memory_recall for content-based retrieval.",
    inputSchema: {
      type: "object",
      properties: {
        matchAll: {
          type: "string",
          description: "Comma-separated dimension:value pairs (AND logic)",
        },
        matchAny: {
          type: "string",
          description: "Comma-separated dimension:value pairs (OR logic)",
        },
        targetType: {
          type: "string",
          description: "Filter by type: action, memory, or observation",
        },
      },
    },
  },
];

export const V061_TOOLS: McpToolDef[] = [
  {
    name: "memory_verify",
    description:
      "Read stored provenance for one memory or observation ID in an explicit project; use '*' only for deliberate cross-project verification. For a memory, returns {success:true,type:'memory',memory,citations,citationCount} with version/strength metadata and visible source observation/session metadata, including recorded confidence. For an observation, returns {success:true,type:'observation',observation,session,citations:[],citationCount:0}, with session:null if unavailable. Missing or out-of-scope IDs return {success:false,error:'not found'}; missing id/project returns an error. This read checks available citation records, not factual truth or completeness, and does not change confidence or access counts. Use memory_smart_search expandIds or memory_timeline to read source content.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Memory ID or observation ID to verify",
        },
        project: {
          type: "string",
          description: "Exact registered project identifier, or '*' for a deliberate cross-project verification",
        },
      },
      required: ["id", "project"],
    },
  },
];

export const V070_TOOLS: McpToolDef[] = [
  {
    name: "memory_lesson_save",
    description:
      "Persist a reusable lesson in an exact project with context, confidence and optional official observation provenance. sources pairs are preferred; sourceIds supplies comma-separated observation IDs, all validated in that project. Matching normalized content strengthens the existing lesson and merges support/tags; otherwise creates one. Returns {success,action,lesson}, with action created or strengthened. Use memory_save for decisions/preferences, and memory_lesson_recall before applying earlier lessons.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The lesson learned (what worked, what to avoid, when to use X approach)",
        },
        context: {
          type: "string",
          description: "When/where this lesson applies",
        },
        confidence: {
          type: "number",
          description: "Initial confidence 0.0-1.0 (default 0.5)",
        },
        project: { type: "string", description: "Project this lesson is about" },
        tags: { type: "string", description: "Comma-separated tags" },
        sourceIds: {
          type: "string",
          description:
            "Comma-separated official observation IDs from this exact project that support the lesson",
        },
        sources: {
          type: "array",
          maxItems: 50,
          description: "Preferred exact provenance pairs from official sessions in this project",
          items: {
            type: "object",
            properties: {
              sessionId: { type: "string" },
              observationIds: {
                type: "array",
                minItems: 1,
                maxItems: 500,
                items: { type: "string" },
              },
            },
            required: ["sessionId", "observationIds"],
          },
        },
      },
      required: ["content", "project"],
    },
  },
  {
    name: "memory_lesson_recall",
    description:
      "Search saved lessons by keywords in an explicit project; '*' deliberately searches across projects. Excludes deleted/archived lessons and those below minConfidence. Returns {success,lessons} with scores ranked by relevance, confidence and recency, bounded by limit. It retrieves existing lessons without generating or reinforcing them. Use before choosing an approach; memory_recall also searches ordinary observations and durable memories.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        project: { type: "string", description: "Filter by project" },
        minConfidence: {
          type: "number",
          description: "Minimum confidence threshold (default 0.1)",
        },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query", "project"],
    },
  },
  {
    name: "memory_lesson_delete",
    description:
      "Soft-delete a lesson by id. Deleted lessons are excluded from recall and list; re-saving the same content creates a fresh lesson.",
    inputSchema: {
      type: "object",
      properties: {
        lessonId: { type: "string", description: "The lesson id (lsn_...)" },
        project: { type: "string", description: "Exact project; required for archive targets. Soft-delete also removes their archive metadata" },
      },
      required: ["lessonId"],
    },
  },
  {
    name: "memory_obsidian_export",
    description:
      "Write Obsidian Markdown notes and MOC.md for selected memories, lessons, crystals and sessions, with frontmatter and wikilinks. types is comma-separated; omission exports all four collections. vaultDir must stay under AGENTMEMORY_EXPORT_ROOT (default ~/.agentmemory). Creates directories and overwrites matching generated filenames; records an audit entry. Returns per-type exported counts, vaultDir and any per-file errors. Use memory_export for returned JSON instead of filesystem output.",
    inputSchema: {
      type: "object",
      properties: {
        vaultDir: {
          type: "string",
          description: "Output directory (default ~/.agentmemory/vault/)",
        },
        types: {
          type: "string",
          description: "Comma-separated types to export: memories,lessons,crystals,sessions (default all)",
        },
      },
    },
  },
];

export const V073_TOOLS: McpToolDef[] = [
  {
    name: "memory_reflect",
    description:
      "Synthesize new insights or reinforce existing ones from project concept clusters using an enabled LLM. Requires an exact project and rejects '*' or noop-provider mode. Uses stored graph clusters or a similarity fallback over facts/lessons; persists insights and audit state. Returns newInsights, reinforced, clustersProcessed, clustersSkipped and usedFallback. Use memory_insight_list to read existing insights or memory_patterns for deterministic recurring file/error patterns.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Filter by project" },
        maxClusters: {
          type: "number",
          description: "Max concept clusters to process (default 10, max 20)",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "memory_insight_list",
    description:
      "Read existing synthesized insights, excluding deleted entries and filtering by optional exact project and minConfidence. Returns {success,insights}, highest confidence first and bounded by limit (default 50). Omitted project lists insights across projects. This does not generate new insights; use memory_reflect for LLM synthesis or memory_lesson_recall for learned procedures and lessons.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Filter by project" },
        minConfidence: {
          type: "number",
          description: "Minimum confidence threshold (default 0)",
        },
        limit: { type: "number", description: "Max results (default 50)" },
      },
    },
  },
];

export const V010_SLOTS_TOOLS: McpToolDef[] = [
  {
    name: "memory_slot_list",
    description:
      "List effective editable memory slots, sorted by label, returning {success,slots} with content, size limits, pinning and scope. Project-scope slots shadow global slots with the same label; unpinned and empty slots are included. Use to inspect current context before creating or editing a slot, or memory_slot_get when you know its label. Slots are fixed-size context units rather than relevance-ranked memories.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_slot_get",
    description: "Read the effective slot named by label, returning {success,slot,scope} with its content and metadata. A project-scope slot takes precedence over a global slot with the same label. Invalid labels or missing slots return success:false. Use memory_slot_list to discover labels, and memory_slot_replace or memory_slot_append to edit the retrieved context unit.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Slot label (e.g. 'persona', 'pending_items')" },
      },
      required: ["label"],
    },
  },
  {
    name: "memory_slot_create",
    description: "Persist a new size-limited context slot, returning {success,slot}. label is lowercase, starts with a letter, uses letters/digits/underscores and is at most 64 characters. sizeLimit is an integer from 1 to 20000; content must fit. Rejects duplicate labels within the selected scope; a project slot can shadow a global one. Pinned slots participate in context injection. Use memory_slot_replace for existing content; creation records an audit entry.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Slot label — lowercase, starts with letter, [a-z0-9_]" },
        content: { type: "string", description: "Initial content (default empty)" },
        sizeLimit: { type: "number", description: "Max chars (default 2000, hard cap 20000)" },
        description: { type: "string", description: "What this slot is for" },
        pinned: { type: "string", description: "'false' to exclude from context injection; default true" },
        scope: { type: "string", description: "'project' (default) or 'global' (shared across projects)" },
      },
      required: ["label"],
    },
  },
  {
    name: "memory_slot_append",
    description:
      "Append text to an existing effective slot, inserting a newline when needed, and record an audit entry. Returns the updated slot and size, or success:false for a missing/read-only slot or sizeLimit overflow. Overflow leaves the content unchanged; use memory_slot_replace to compact it first. Project slots shadow global slots with the same label. Repeated calls append again; use memory_slot_create when the label does not exist.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Slot label" },
        text: { type: "string", description: "Text to append" },
      },
      required: ["label", "text"],
    },
  },
  {
    name: "memory_slot_replace",
    description: "Replace the complete content of an existing effective slot, preserving its metadata and size limit. Empty content clears the slot. Returns {success,slot,size}; missing/read-only slots or oversized content fail without replacement. Project slots take precedence over global slots with the same label. Records an audit entry. Use memory_slot_append to add text or memory_slot_create for a new label.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Slot label" },
        content: { type: "string", description: "New full content" },
      },
      required: ["label", "content"],
    },
  },
  {
    name: "memory_slot_delete",
    description: "Delete the effective slot and record an audit entry, returning {success:true}. Missing or read-only slots fail; seeded default slots are deletable when writable. With duplicate labels, deletes the project slot first, revealing the global slot on later reads. This removes the context unit rather than clearing its content; use memory_slot_replace with empty content to retain it.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Slot label" },
      },
      required: ["label"],
    },
  },
];

export const ESSENTIAL_TOOLS = new Set([
  "memory_save",
  "memory_recall",
  "memory_consolidate",
  "memory_smart_search",
  "memory_sessions",
  "memory_diagnose",
  "memory_lesson_save",
  "memory_reflect",
]);

export function getAllTools(): McpToolDef[] {
  return [
    ...CORE_TOOLS,
    ...V040_TOOLS,
    ...V050_TOOLS,
    ...V051_TOOLS,
    ...V061_TOOLS,
    ...V070_TOOLS,
    ...V073_TOOLS,
    ...V010_SLOTS_TOOLS,
  ];
}

// Default is the complete registered surface. The lean essentials remain
// available for hosts that explicitly request AGENTMEMORY_TOOLS=core.
export function getVisibleTools(): McpToolDef[] {
  const mode = process.env["AGENTMEMORY_TOOLS"] || "all";
  if (mode === "core") return getAllTools().filter((t) => ESSENTIAL_TOOLS.has(t.name));
  return getAllTools();
}
