export function float32ToBase64(arr: Float32Array): string {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString(
    "base64",
  );
}

export function base64ToFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export type VectorEntry = { embedding: Float32Array; sessionId: string };

export type VectorChangeListener = (obsId: string | null, entry: VectorEntry | null) => void;

export class VectorIndex {
  private vectors: Map<string, VectorEntry> = new Map();
  private changes: Map<string, boolean> = new Map();
  private listener: VectorChangeListener | null = null;

  setChangeListener(listener: VectorChangeListener | null): void {
    this.listener = listener;
  }

  private changeCapture: Set<string> | null = null;
  private captureReset = false;

  add(obsId: string, sessionId: string, embedding: Float32Array): void {
    this.changeCapture?.add(obsId);
    const entry = { embedding, sessionId };
    this.vectors.set(obsId, entry);
    this.changes.set(obsId, true);
    this.listener?.(obsId, entry);
  }

  remove(obsId: string): void {
    this.changeCapture?.add(obsId);
    if (this.vectors.delete(obsId)) {
      this.changes.set(obsId, false);
      this.listener?.(obsId, null);
    }
  }

  has(obsId: string): boolean {
    return this.vectors.has(obsId);
  }

  get(obsId: string): VectorEntry | undefined {
    return this.vectors.get(obsId);
  }

  entries(): IterableIterator<[string, VectorEntry]> {
    return this.vectors.entries();
  }

  loadPersisted(obsId: string, sessionId: string, embedding: Float32Array): void {
    this.vectors.set(obsId, { embedding, sessionId });
  }

  get pendingChanges(): number {
    return this.changes.size;
  }

  hasPendingChange(obsId: string): boolean {
    return this.changes.has(obsId);
  }

  takeChanges(): Map<string, boolean> {
    const taken = this.changes;
    this.changes = new Map();
    return taken;
  }

  returnChanges(changes: Map<string, boolean>): void {
    for (const [obsId, present] of changes) {
      if (!this.changes.has(obsId)) this.changes.set(obsId, present);
    }
  }

  markRemoved(obsId: string): void {
    if (!this.vectors.has(obsId)) {
      this.changes.set(obsId, false);
      this.listener?.(obsId, null);
    }
  }

  markAllChanged(): void {
    for (const obsId of this.vectors.keys()) this.changes.set(obsId, true);
  }

  search(
    query: Float32Array,
    limit = 20,
    eligible?: (obsId: string) => boolean,
  ): Array<{ obsId: string; sessionId: string; score: number }> {
    const results: Array<{
      obsId: string;
      sessionId: string;
      score: number;
    }> = [];
    let minScore = -Infinity;

    for (const [obsId, entry] of this.vectors) {
      if (eligible && !eligible(obsId)) continue;
      const score = cosineSimilarity(query, entry.embedding);
      if (results.length < limit) {
        results.push({ obsId, sessionId: entry.sessionId, score });
        if (results.length === limit) {
          results.sort((a, b) => a.score - b.score);
          minScore = results[0].score;
        }
      } else if (score > minScore) {
        results[0] = { obsId, sessionId: entry.sessionId, score };
        results.sort((a, b) => a.score - b.score);
        minScore = results[0].score;
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  get size(): number {
    return this.vectors.size;
  }

  // Walks every stored vector and returns the obsIds whose dimension
  // doesn't match `expected`, plus the set of distinct dimensions seen.
  // Used by the persistence-restore guard in src/index.ts to refuse
  // loading any index containing wrong-dimension vectors — including
  // legacy on-disk indexes written before the live-API dimension guard
  // existed (where a mid-session provider swap could mix dimensions
  // inside a single index). Empty `mismatches` plus a single-entry
  // `seenDimensions` matching `expected` is the only clean state.
  validateDimensions(
    expected: number,
  ): { mismatches: Array<{ obsId: string; dim: number }>; seenDimensions: Set<number> } {
    const mismatches: Array<{ obsId: string; dim: number }> = [];
    const seenDimensions = new Set<number>();
    for (const [obsId, entry] of this.vectors) {
      const dim = entry.embedding.length;
      seenDimensions.add(dim);
      if (dim !== expected) {
        mismatches.push({ obsId, dim });
      }
    }
    return { mismatches, seenDimensions };
  }

  clear(): void {
    if (this.changeCapture) this.captureReset = true;
    const hadVectors = this.vectors.size > 0;
    for (const obsId of this.vectors.keys()) this.changes.set(obsId, false);
    this.vectors.clear();
    if (hadVectors) this.listener?.(null, null);
  }

  markChanged(obsId: string): void {
    const entry = this.vectors.get(obsId);
    if (!entry) return;
    this.changes.set(obsId, true);
    this.listener?.(obsId, entry);
  }

  restoreFrom(other: VectorIndex, options: { persisted?: boolean } = {}): void {
    if (this.changeCapture) this.captureReset = true;
    const previous = this.vectors;
    const src = other.vectors;
    this.vectors = new Map();
    for (const [obsId, entry] of src) {
      this.vectors.set(obsId, {
        embedding: new Float32Array(entry.embedding),
        sessionId: entry.sessionId,
      });
    }
    if (options.persisted) {
      this.changes = new Map(other.changes);
      return;
    }
    for (const id of previous.keys()) {
      if (!this.vectors.has(id)) {
        this.changes.set(id, false);
        this.listener?.(id, null);
      }
    }
    for (const id of this.vectors.keys()) this.markChanged(id);
  }

  copyMatchingTo(target: VectorIndex, keep: (id: string) => boolean): void {
    for (const [id, entry] of this.vectors) {
      if (keep(id)) target.add(id, entry.sessionId, new Float32Array(entry.embedding));
    }
  }

  captureChanges(): { applyTo: (target: VectorIndex, keep?: (id: string) => boolean) => void; stop: () => void } {
    if (this.changeCapture) throw new Error("Vector index change capture already active");
    const changed = new Set<string>();
    this.changeCapture = changed;
    this.captureReset = false;
    return {
      applyTo: (target, keep = () => true) => {
        if (this.captureReset) throw new Error("Vector index reset during rebuild");
        for (const id of changed) {
          target.remove(id);
          const entry = this.vectors.get(id);
          if (entry && keep(id)) target.add(id, entry.sessionId, new Float32Array(entry.embedding));
        }
      },
      stop: () => { if (this.changeCapture === changed) this.changeCapture = null; },
    };
  }

  serialize(): string {
    const data: Array<[string, { embedding: string; sessionId: string }]> = [];
    for (const [obsId, entry] of this.vectors) {
      data.push([
        obsId,
        {
          embedding: float32ToBase64(entry.embedding),
          sessionId: entry.sessionId,
        },
      ]);
    }
    return JSON.stringify(data);
  }

  static deserialize(json: string): VectorIndex {
    const idx = new VectorIndex();
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      return idx;
    }
    if (!Array.isArray(data)) return idx;
    for (const row of data) {
      try {
        if (!Array.isArray(row) || row.length < 2) continue;
        const [obsId, entry] = row;
        if (
          typeof obsId !== "string" ||
          typeof entry?.embedding !== "string" ||
          typeof entry?.sessionId !== "string"
        )
          continue;
        idx.vectors.set(obsId, {
          embedding: base64ToFloat32(entry.embedding),
          sessionId: entry.sessionId,
        });
      } catch {
        continue;
      }
    }
    return idx;
  }
}
