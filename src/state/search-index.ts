import type { CompressedObservation } from "../types.js";
import { stem } from "./stemmer.js";
import { getSynonyms } from "./synonyms.js";
import { segmentCjk, hasCjk } from "./cjk-segmenter.js";

interface IndexEntry {
  obsId: string;
  sessionId: string;
  termCount: number;
}

export class SearchIndex {
  private entries: Map<string, IndexEntry> = new Map();
  private invertedIndex: Map<string, Set<string>> = new Map();
  private docTermCounts: Map<string, Map<string, number>> = new Map();
  private totalDocLength = 0;
  private sortedTerms: string[] | null = null;
  private changeCapture: Set<string> | null = null;
  private captureReset = false;
  private mutationRevision = 0;
  private hangulBigrams: { revision: number; terms: Map<string, Set<string>> } | null = null;

  private hangulLengths: { lengths: Map<string, number>; total: number } | null = null;

  private readonly k1 = 1.2;
  private readonly b = 0.75;

  add(obs: CompressedObservation): void {
    const terms = this.extractTerms(obs);
    const termFreq = new Map<string, number>();
    let termCount = 0;

    for (const term of terms) {
      termFreq.set(term, (termFreq.get(term) || 0) + 1);
      termCount++;
    }

    const previous = this.entries.get(obs.id);
    const previousTerms = this.docTermCounts.get(obs.id);
    if (
      previous?.sessionId === obs.sessionId &&
      previous.termCount === termCount &&
      previousTerms?.size === termFreq.size &&
      [...termFreq].every(([term, count]) => previousTerms.get(term) === count)
    ) return;

    this.remove(obs.id);
    this.entries.set(obs.id, {
      obsId: obs.id,
      sessionId: obs.sessionId,
      termCount,
    });
    this.docTermCounts.set(obs.id, termFreq);
    this.totalDocLength += termCount;

    for (const term of termFreq.keys()) {
      if (!this.invertedIndex.has(term)) {
        this.invertedIndex.set(term, new Set());
        this.sortedTerms = null;
        if (this.hangulBigrams) for (const gram of this.hangulGrams(term)) {
          if (!this.hangulBigrams.terms.has(gram)) this.hangulBigrams.terms.set(gram, new Set());
          this.hangulBigrams.terms.get(gram)!.add(term);
        }
      }
      this.invertedIndex.get(term)!.add(obs.id);
    }

    this.updateHangulLength(obs.id, termFreq);
    this.mutationRevision++;
    if (this.hangulBigrams) this.hangulBigrams.revision = this.mutationRevision;
  }

  getSessionId(id: string): string | undefined {
    return this.entries.get(id)?.sessionId;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  sessionOf(id: string): string | undefined {
    return this.entries.get(id)?.sessionId;
  }

  observationCountsBySession(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const entry of this.entries.values()) {
      if (entry.obsId.startsWith("mem_")) continue;
      counts.set(entry.sessionId, (counts.get(entry.sessionId) ?? 0) + 1);
    }
    return counts;
  }

  documentKindCounts(): { memories: number; lessons: number } {
    let memories = 0;
    let lessons = 0;
    for (const entry of this.entries.values()) {
      if (entry.obsId.startsWith("mem_")) memories++;
      else if (entry.sessionId === "lesson") lessons++;
    }
    return { memories, lessons };
  }

  remove(id: string): void {
    this.changeCapture?.add(id);
    const entry = this.entries.get(id);
    if (!entry) return;

    const termFreq = this.docTermCounts.get(id);
    if (termFreq) {
      for (const term of termFreq.keys()) {
        const postingList = this.invertedIndex.get(term);
        if (postingList) {
          postingList.delete(id);
          if (postingList.size === 0) {
            this.invertedIndex.delete(term);
            this.sortedTerms = null;
            if (this.hangulBigrams) for (const gram of this.hangulGrams(term)) {
              const words = this.hangulBigrams.terms.get(gram);
              words?.delete(term);
              if (words?.size === 0) this.hangulBigrams.terms.delete(gram);
            }
          }
        }
      }
      this.docTermCounts.delete(id);
    }

    this.totalDocLength = Math.max(0, this.totalDocLength - entry.termCount);
    this.entries.delete(id);
    if (this.hangulLengths) {
      this.hangulLengths.total -= this.hangulLengths.lengths.get(id) ?? 0;
      this.hangulLengths.lengths.delete(id);
    }
    this.mutationRevision++;
    if (this.hangulBigrams) this.hangulBigrams.revision = this.mutationRevision;
  }

  search(
    query: string,
    limit = 20,
  ): Array<{ obsId: string; sessionId: string; score: number }> {
    const terms = [...new Set(this.tokenize(query.toLowerCase()))];
    if (terms.length < 2 || !terms.some(term => this.hangulGrams(term).size > 0)) {
      return this.searchWords(query, limit);
    }
    const words = this.searchWords(query, this.size);
    const grams = this.searchHangul(terms);
    const combined = new Map<string, { obsId: string; sessionId: string; score: number; wordRank: number }>();
    words.forEach((row, rank) => combined.set(row.obsId, {
      ...row, score: 1 / (60 + rank + 1), wordRank: rank,
    }));
    grams.forEach((row, rank) => {
      const existing = combined.get(row.obsId);
      if (existing) existing.score += 1 / (60 + rank + 1);
      else combined.set(row.obsId, { ...row, score: 1 / (60 + rank + 1), wordRank: Infinity });
    });
    return [...combined.values()]
      .sort((a, b) => b.score - a.score || a.wordRank - b.wordRank)
      .slice(0, limit)
      .map(({ wordRank, ...row }) => row);
  }

  private searchHangul(terms: string[]): Array<{ obsId: string; sessionId: string; score: number }> {
    if (this.size === 0) return [];
    if (!this.hangulLengths) {
      const lengths = new Map<string, number>();
      let total = 0;
      for (const [id, counts] of this.docTermCounts) {
        const length = this.hangulDocumentLength(counts);
        lengths.set(id, length);
        total += length;
      }
      this.hangulLengths = { lengths, total };
    }
    const { lengths, total } = this.hangulLengths;
    const average = total / this.size;
    const scores = new Map<string, number>();
    const seenGrams = new Set<string>();
    for (const term of terms) {
      const grams = this.hangulGrams(term);
      if (grams.size === 0) {
        for (const row of this.searchWords(term, this.size)) {
          scores.set(row.obsId, (scores.get(row.obsId) ?? 0) + row.score);
        }
        continue;
      }
      for (const gram of grams) {
        if (seenGrams.has(gram)) continue;
        seenGrams.add(gram);
        const frequencies = new Map<string, number>();
        for (const candidate of this.getHangulBigrams().get(gram) ?? []) {
          let occurrences = 0;
          for (let i = 0; i < candidate.length - 1; i++) {
            if (candidate.slice(i, i + 2) === gram) occurrences++;
          }
          for (const id of this.invertedIndex.get(candidate)!) {
            const tf = this.docTermCounts.get(id)!.get(candidate)! * occurrences;
            frequencies.set(id, (frequencies.get(id) ?? 0) + tf);
          }
        }
        const idf = Math.log((this.size - frequencies.size + 0.5) / (frequencies.size + 0.5) + 1);
        for (const [id, tf] of frequencies) {
          const denominator = tf + this.k1 * (1 - this.b + this.b * lengths.get(id)! / average);
          const score = idf * tf * (this.k1 + 1) / denominator;
          scores.set(id, (scores.get(id) ?? 0) + score);
        }
      }
    }
    return [...scores].map(([obsId, score]) => ({
      obsId, sessionId: this.entries.get(obsId)!.sessionId, score,
    })).sort((a, b) => b.score - a.score);
  }

  private searchWords(
    query: string,
    limit = 20,
  ): Array<{ obsId: string; sessionId: string; score: number }> {
    const rawTerms = this.tokenize(query.toLowerCase());
    if (rawTerms.length === 0) return [];

    const N = this.entries.size;
    if (N === 0) return [];
    const avgDocLen = this.totalDocLength / N;

    const queryTerms: Array<{ term: string; weight: number }> = [];
    const seen = new Set<string>();
    for (const term of rawTerms) {
      if (!seen.has(term)) {
        seen.add(term);
        queryTerms.push({ term, weight: 1.0 });
      }
      for (const syn of getSynonyms(term)) {
        if (!seen.has(syn)) {
          seen.add(syn);
          queryTerms.push({ term: syn, weight: 0.7 });
        }
      }
    }

    const scores = new Map<string, number>();
    const sorted = this.getSortedTerms();

    for (const { term, weight } of queryTerms) {
      const matchingDocs = this.invertedIndex.get(term);
      let minimumExactScore = Infinity;
      if (matchingDocs) {
        const df = matchingDocs.size;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

        for (const obsId of matchingDocs) {
          const entry = this.entries.get(obsId)!;
          const docTerms = this.docTermCounts.get(obsId);
          const tf = docTerms?.get(term) || 0;
          const docLen = entry.termCount;

          const numerator = tf * (this.k1 + 1);
          const denominator =
            tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen));
          const bm25Score = idf * (numerator / denominator) * weight;
          minimumExactScore = Math.min(minimumExactScore, bm25Score);

          scores.set(obsId, (scores.get(obsId) || 0) + bm25Score);
        }
      }

      if (/^\p{N}+$/u.test(term)) continue;
      const startIdx = this.lowerBound(sorted, term);
      const prefixScores = new Map<string, number>();
      for (let si = startIdx; si < sorted.length; si++) {
        const indexTerm = sorted[si];
        if (!indexTerm.startsWith(term)) break;
        if (indexTerm === term) continue;

        const obsIds = this.invertedIndex.get(indexTerm)!;
        const prefixDf = Math.max(matchingDocs?.size ?? 0, obsIds.size);
        const prefixIdf =
          Math.log((N - prefixDf + 0.5) / (prefixDf + 0.5) + 1) * 0.5;
        for (const obsId of obsIds) {
          if (matchingDocs?.has(obsId)) continue;
          const entry = this.entries.get(obsId)!;
          const docTerms = this.docTermCounts.get(obsId);
          const tf = docTerms?.get(indexTerm) || 0;
          const docLen = entry.termCount;
          const numerator = tf * (this.k1 + 1);
          const denominator =
            tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen));
          const score = prefixIdf * (numerator / denominator) * weight;
          prefixScores.set(obsId, Math.max(prefixScores.get(obsId) || 0, score));
        }
      }
      for (const [id, score] of prefixScores) scores.set(id, (scores.get(id) || 0) + score);

      const grams = this.hangulGrams(term);
      if (grams.size === 0) continue;
      const candidates = new Map<string, number>();
      for (const gram of grams) {
        for (const candidate of this.getHangulBigrams().get(gram) || []) {
          candidates.set(candidate, (candidates.get(candidate) || 0) + 1);
        }
      }
      const partialScores = new Map<string, number>();
      const primaryDocs = new Set(matchingDocs);
      for (let si = startIdx; si < sorted.length && sorted[si].startsWith(term); si++) {
        for (const id of this.invertedIndex.get(sorted[si])!) primaryDocs.add(id);
      }
      for (const [candidate, overlap] of candidates) {
        if (candidate.startsWith(term) || overlap / grams.size < 0.5) continue;
        const ids = this.invertedIndex.get(candidate)!;
        const df = matchingDocs?.size || ids.size;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        for (const id of ids) {
          if (primaryDocs.has(id)) continue;
          const entry = this.entries.get(id)!;
          const tf = this.docTermCounts.get(id)!.get(candidate)!;
          const denominator = tf + this.k1 * (1 - this.b + this.b * entry.termCount / avgDocLen);
          const score = Math.min(minimumExactScore * 0.25,
            idf * tf * (this.k1 + 1) / denominator * weight * 0.25 * overlap / grams.size);
          partialScores.set(id, Math.max(partialScores.get(id) || 0, score));
        }
      }
      for (const [id, score] of partialScores) scores.set(id, (scores.get(id) || 0) + score);
    }

    return Array.from(scores.entries())
      .map(([obsId, score]) => {
        const entry = this.entries.get(obsId)!;
        return { obsId, sessionId: entry.sessionId, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  get size(): number {
    return this.entries.size;
  }

  get revision(): number {
    return this.mutationRevision;
  }

  clear(): void {
    if (this.changeCapture) this.captureReset = true;
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.invertedIndex.clear();
    this.docTermCounts.clear();
    this.totalDocLength = 0;
    this.sortedTerms = null;
    this.hangulBigrams = null;
    this.hangulLengths = null;
    this.mutationRevision++;
  }

  restoreFrom(other: SearchIndex): void {
    if (this.changeCapture) this.captureReset = true;
    this.entries = new Map(
      Array.from(other.entries.entries()).map(([k, v]) => [k, { ...v }]),
    );
    this.invertedIndex = new Map(
      Array.from(other.invertedIndex.entries()).map(([k, v]) => [
        k,
        new Set(v),
      ]),
    );
    this.docTermCounts = new Map(
      Array.from(other.docTermCounts.entries()).map(([k, v]) => [
        k,
        new Map(v),
      ]),
    );
    this.totalDocLength = other.totalDocLength;
    this.sortedTerms = null;
    this.hangulBigrams = null;
    this.hangulLengths = null;
    this.mutationRevision++;
  }

  captureChanges(): { applyTo: (target: SearchIndex) => void; stop: () => void } {
    if (this.changeCapture) throw new Error("Search index change capture already active");
    const changed = new Set<string>();
    this.changeCapture = changed;
    this.captureReset = false;
    return {
      applyTo: target => {
        if (this.captureReset) throw new Error("Search index reset during rebuild");
        for (const id of changed) {
          target.remove(id);
          const entry = this.entries.get(id);
          const terms = this.docTermCounts.get(id);
          if (!entry || !terms) continue;
          target.entries.set(id, { ...entry });
          target.docTermCounts.set(id, new Map(terms));
          target.totalDocLength += entry.termCount;
          for (const term of terms.keys()) {
            if (!target.invertedIndex.has(term)) {
              target.invertedIndex.set(term, new Set());
              target.sortedTerms = null;
              if (target.hangulBigrams) for (const gram of target.hangulGrams(term)) {
                if (!target.hangulBigrams.terms.has(gram)) target.hangulBigrams.terms.set(gram, new Set());
                target.hangulBigrams.terms.get(gram)!.add(term);
              }
            }
            target.invertedIndex.get(term)!.add(id);
          }
          target.updateHangulLength(id, terms);
          target.mutationRevision++;
          if (target.hangulBigrams) target.hangulBigrams.revision = target.mutationRevision;
        }
      },
      stop: () => { if (this.changeCapture === changed) this.changeCapture = null; },
    };
  }

  serialize(): string {
    const documents = [...this.entries.values()].map(
      ({ obsId, sessionId, termCount }) => [obsId, sessionId, termCount],
    );
    const terms = [...this.invertedIndex.keys()];
    const documentIds = new Map([...this.entries.keys()].map((id, position) => [id, position]));
    const termIds = new Map(terms.map((term, position) => [term, position]));
    return JSON.stringify({
      v: 3,
      documents,
      terms,
      postings: [...this.invertedIndex.values()].map(ids => [...ids].map(id => documentIds.get(id))),
      docTerms: [...this.docTermCounts].map(([id, counts]) => [
        documentIds.get(id), [...counts].map(([term, count]) => [termIds.get(term), count]),
      ]),
      totalDocLength: this.totalDocLength,
    });
  }

  static deserialize(json: string): SearchIndex {
    try {
      const idx = new SearchIndex();
      const data = JSON.parse(json);
      if (data?.v === 3) {
        if (!Array.isArray(data.documents) || !Array.isArray(data.terms) ||
            !Array.isArray(data.postings) || !Array.isArray(data.docTerms) ||
            data.postings.length !== data.terms.length) return idx;
        const documents: string[] = [];
        for (const [obsId, sessionId, termCount] of data.documents) {
          if (typeof obsId !== "string" || typeof sessionId !== "string" ||
              !Number.isInteger(termCount) || termCount < 0) throw new Error("Invalid index document");
          documents.push(obsId);
          idx.entries.set(obsId, { obsId, sessionId, termCount });
        }
        const terms: string[] = data.terms;
        if (idx.entries.size !== documents.length || terms.some(term => typeof term !== "string") ||
            new Set(terms).size !== terms.length) throw new Error("Invalid index dictionary");
        const documentAt = (position: number): string => {
          if (!Number.isInteger(position) || position < 0 || position >= documents.length) {
            throw new Error("Invalid index document reference");
          }
          return documents[position]!;
        };
        const termAt = (position: number): string => {
          if (!Number.isInteger(position) || position < 0 || position >= terms.length) {
            throw new Error("Invalid index term reference");
          }
          return terms[position]!;
        };
        for (let position = 0; position < terms.length; position++) {
          idx.invertedIndex.set(terms[position]!, new Set(data.postings[position].map(documentAt)));
        }
        for (const [position, counts] of data.docTerms) {
          const decoded = new Map<string, number>();
          for (const [term, count] of counts) {
            if (!Number.isInteger(count) || count < 1) throw new Error("Invalid index term frequency");
            decoded.set(termAt(term), count);
          }
          idx.docTermCounts.set(documentAt(position), decoded);
        }
        if (idx.docTermCounts.size !== documents.length) throw new Error("Incomplete index documents");
      } else {
        if (!data?.entries || !data?.inverted || !data?.docTerms) return idx;
        for (const [key, val] of data.entries) idx.entries.set(key, val);
        for (const [term, ids] of data.inverted) idx.invertedIndex.set(term, new Set(ids));
        for (const [id, counts] of data.docTerms) idx.docTermCounts.set(id, new Map(counts));
      }
      const rawLen = Number(data.totalDocLength);
      idx.totalDocLength =
        Number.isFinite(rawLen) && rawLen >= 0 ? Math.floor(rawLen) : 0;
      return idx;
    } catch {
      return new SearchIndex();
    }
  }

  private extractTerms(obs: CompressedObservation): string[] {
    const parts = [
      obs.title,
      obs.subtitle || "",
      obs.narrative,
      ...obs.facts,
      ...obs.concepts,
      ...obs.files,
      obs.type,
    ];
    return this.tokenize(parts.join(" ").toLowerCase());
  }

  private tokenize(text: string): string[] {
    const cleaned = text.replace(/[^\p{L}\p{N}\s/.\\-_]/gu, " ");
    const out: string[] = [];
    for (const raw of cleaned.split(/\s+/)) {
      if (raw.length < 2) continue;
      if (hasCjk(raw)) {
        for (const seg of segmentCjk(raw)) {
          if (seg.length >= 1) out.push(seg);
        }
      } else {
        out.push(stem(raw));
        if (raw.includes("\\_") && !raw.includes("/") && !raw.startsWith("\\")) {
          const unescaped = raw.replace(/\\_/g, "_").replace(/\\+$/, "");
          if (!unescaped.includes("\\") && unescaped.length >= 2) {
            out.push(stem(unescaped));
          }
        }
      }
    }
    return out;
  }

  private getSortedTerms(): string[] {
    if (!this.sortedTerms) {
      this.sortedTerms = Array.from(this.invertedIndex.keys()).sort();
    }
    return this.sortedTerms;
  }

  private hangulDocumentLength(counts: Map<string, number>): number {
    let length = 0;
    for (const [term, tf] of counts) length += tf * (/^[가-힣]{2,}$/u.test(term) ? term.length - 1 : 1);
    return length;
  }

  private updateHangulLength(id: string, counts: Map<string, number>): void {
    if (!this.hangulLengths) return;
    const length = this.hangulDocumentLength(counts);
    this.hangulLengths.total += length - (this.hangulLengths.lengths.get(id) ?? 0);
    this.hangulLengths.lengths.set(id, length);
  }

  private hangulGrams(term: string): Set<string> {
    if (!/^[가-힣]{2,}$/u.test(term)) return new Set();
    return new Set(Array.from({ length: term.length - 1 }, (_, i) => term.slice(i, i + 2)));
  }

  private getHangulBigrams(): Map<string, Set<string>> {
    if (this.hangulBigrams?.revision === this.mutationRevision) return this.hangulBigrams.terms;
    const terms = new Map<string, Set<string>>();
    for (const term of this.invertedIndex.keys()) {
      for (const gram of this.hangulGrams(term)) {
        if (!terms.has(gram)) terms.set(gram, new Set());
        terms.get(gram)!.add(term);
      }
    }
    this.hangulBigrams = { revision: this.mutationRevision, terms };
    return terms;
  }

  private lowerBound(arr: string[], target: string): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
