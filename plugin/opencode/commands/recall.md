Search past session observations and lessons for relevant context. Wrap the `memory_smart_search` and `memory_lesson_recall` MCP tools.

## Usage

```
/recall [query]
```

## Instructions

1. Resolve the exact registered project for the current repository.
2. Call `memory_smart_search` with that `project`, the query, and `limit: 10` (hybrid BM25 + vector + graph search).
3. Call `memory_lesson_recall` with the same `project`, query, and `limit: 5` (lesson search).
4. Combine results and present to the user:
   - Group by session
   - Show type, title, and narrative for each observation
   - Highlight high-importance (>= 7) observations
   - Show lessons separately with confidence scores
5. If no results, suggest 2-3 alternative search terms.
6. **Never hallucinate results.** Only present what the MCP tools actually return.
