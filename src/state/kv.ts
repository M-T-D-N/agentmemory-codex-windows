import type { ISdk } from 'iii-sdk'
import { KV, OBSERVATION_REFERENCE_ROW_SCOPES } from './schema.js'
import { inObservationRecovery, withObservationWrite } from './observation-write.js'

type Row = Record<string, any>
const OBS = 'mem:obs:'
const SESSIONS = 'mem:sessions'
const referenceScopes = new Set<string>([...OBSERVATION_REFERENCE_ROW_SCOPES, KV.graphSnapshot, KV.graphQueryDocuments, KV.graphQueryAdjacency])

export function isDeletedObservation(row: unknown): boolean {
  return !!row && typeof row === 'object' && (row as Row).emptyDeletion?.state === 'deleted'
}

export class StateKV {
  private recoveryRows = new Map<string, Row>()
  private recoveryReady?: Promise<void>
  private recoveryUncertain = false
  constructor(private sdk: ISdk) {}

  async initializeObservationRecovery(): Promise<void> {
    this.recoveryReady ??= (async () => {
      const groups = (await this.listGroups()).filter(scope => scope.startsWith(OBS))
      let next = 0
      const rows = new Map<string, Row>()
      const scan = async () => {
        for (;;) {
          const scope = groups[next++]
          if (!scope) return
          for (const row of await this.list<Row>(scope, { includeDeleted: true })) {
            if (row.emptyDeletion === undefined) continue
            const state = row.emptyDeletion
            if (typeof row.id !== 'string' || scope !== OBS + row.sessionId ||
                !['deleted', 'restored'].includes(state?.state) || !Number.isSafeInteger(state.version) || state.version < 1) {
              throw new Error('Invalid observation recovery metadata; writes remain disabled')
            }
            if (rows.has(row.id)) throw new Error('Duplicate recovery observation ID')
            rows.set(row.id, row)
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(8, groups.length) }, scan))
      this.recoveryRows = rows
    })()
    await this.recoveryReady
    if (this.recoveryUncertain) throw new Error('Observation recovery write outcome is uncertain; verify canonical state and restart the worker before writing')
  }

  hasObservationRecovery(sessionId?: string): boolean {
    return [...this.recoveryRows.values()].some(row => !sessionId || row.sessionId === sessionId)
  }

  assertRecoveryImportAllowed(value: unknown, replace = false): void {
    if (replace && this.recoveryRows.size) throw new Error('Replace import would erase recoverable observations')
    const protectedIds = new Set([...this.recoveryRows.keys(), ...[...this.recoveryRows.values()].map(row => row.sessionId)])
    const visit = (item: unknown): void => {
      if (typeof item === 'string' && protectedIds.has(item)) throw new Error('Import targets a protected observation or session; use the empty observation lifecycle')
      if (item && typeof item === 'object') {
        for (const [key, child] of Object.entries(item)) {
          if (key === 'emptyDeletion' || protectedIds.has(key)) throw new Error('Import cannot install or overwrite observation recovery metadata')
          visit(child)
        }
      }
    }
    visit(value)
  }

  private assertSources(value: unknown): void {
    const visit = (item: unknown): void => {
      if (typeof item === 'string' && isDeletedObservation(this.recoveryRows.get(item))) {
        throw new Error('Cannot reference a deleted observation: ' + item)
      }
      if (item && typeof item === 'object') for (const child of Object.values(item)) visit(child)
    }
    if (this.recoveryRows.size) visit(value)
  }

  private async guardSet(scope: string, key: string, value: unknown): Promise<unknown> {
    await this.initializeObservationRecovery()
    if (scope.startsWith(OBS)) {
      if (this.recoveryRows.has(key) || (value as Row)?.emptyDeletion !== undefined) {
        throw new Error('Protected observation requires the empty observation lifecycle')
      }
    }
    if (referenceScopes.has(scope) || scope.startsWith(OBS) || scope.startsWith('mem:enriched:')) this.assertSources(value)
    if (scope === SESSIONS && this.hasObservationRecovery(key)) {
      const current = await this.get<Row>(scope, key)
      const row = value as Row
      if (!row || row.id !== key || row.project !== current?.project || (row.semanticGraphBootstrapSkipped ?? 0) !== 0 || row.semanticGraphBackfillThroughObservationId) {
        throw new Error('Cannot replace a protected session identity or bootstrap cursor')
      }
      const anchor = await this.get<Row>(OBS + key, row.semanticGraphThroughObservationId)
      const protectedRows = [...this.recoveryRows.values()].filter(obs => obs.sessionId === key)
      if (!anchor || anchor.sessionId !== key || protectedRows.some(obs => anchor.timestamp.localeCompare(obs.timestamp) < 0 || (anchor.timestamp === obs.timestamp && anchor.id.localeCompare(obs.id) <= 0))) {
        throw new Error('Cannot move a protected session cursor before a recoverable observation')
      }
      return { ...row, observationCount: (await this.list(OBS + key)).length }
    }
    return value
  }

  async get<T = unknown>(scope: string, key: string, options?: { includeDeleted?: boolean }): Promise<T | null> {
    const row = await this.sdk.trigger<{ scope: string; key: string }, T | null>({ function_id: 'state::get', payload: { scope, key } })
    return scope.startsWith(OBS) && !options?.includeDeleted && isDeletedObservation(row) ? null : row
  }

  private async mutate<T>(functionId: string, payload: { scope: string; [key: string]: unknown }): Promise<T> {
    try {
      return await this.sdk.trigger<any, T>({ function_id: functionId, payload })
    } catch (error) {
      if (payload.scope === SESSIONS || payload.scope.startsWith(OBS) || payload.scope.startsWith('mem:enriched:') || referenceScopes.has(payload.scope)) {
        this.recoveryUncertain = true
      }
      throw error
    }
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    return withObservationWrite(async () => {
      const guarded = await this.guardSet(scope, key, value)
      return this.mutate<T>('state::set', { scope, key, value: guarded })
    })
  }

  async update<T = unknown>(scope: string, key: string, ops: Array<{ type: string; path: string; value?: unknown }>): Promise<T> {
    return withObservationWrite(async () => {
      await this.initializeObservationRecovery()
      if (scope.startsWith(OBS) && this.recoveryRows.has(key)) throw new Error('Protected observation cannot be updated')
      if (scope === SESSIONS && this.hasObservationRecovery(key)) {
        if (ops.some(op => op.type !== 'set' || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(op.path))) throw new Error('Protected session supports only top-level set updates')
        const current = await this.get<Row>(scope, key)
        const updated = { ...current }
        for (const op of ops) updated[op.path] = op.value
        const guarded = await this.guardSet(scope, key, updated) as Row
        const finalOps = ops.filter(op => op.path !== 'observationCount')
        finalOps.push({ type: 'set', path: 'observationCount', value: guarded.observationCount })
        return this.mutate<T>('state::update', { scope, key, ops: finalOps })
      }
      if (referenceScopes.has(scope) || scope.startsWith(OBS) || scope.startsWith('mem:enriched:')) {
        this.assertSources(ops)
        if (ops.some(op => op.path.includes('emptyDeletion'))) throw new Error('Recovery metadata requires the empty observation lifecycle')
      }
      return this.mutate<T>('state::update', { scope, key, ops })
    })
  }

  async delete(scope: string, key: string): Promise<void> {
    return withObservationWrite(async () => {
      await this.initializeObservationRecovery()
      if ((scope === SESSIONS && this.hasObservationRecovery(key)) || (scope.startsWith(OBS) && this.hasObservationRecovery(scope.slice(OBS.length)))) {
        throw new Error('Protected session or observation cannot be permanently deleted')
      }
      return this.mutate<void>('state::delete', { scope, key })
    })
  }

  async writeEmptyObservation(row: Row): Promise<void> {
    if (!inObservationRecovery()) throw new Error('Exclusive observation recovery is required')
    await this.initializeObservationRecovery()
    try {
      await this.sdk.trigger({ function_id: 'state::set', payload: { scope: OBS + row.sessionId, key: row.id, value: row } })
      this.recoveryRows.set(row.id, row)
    } catch (error) {
      this.recoveryUncertain = true
      throw error
    }
  }

  async listGroups(): Promise<string[]> {
    const response = await this.sdk.trigger<Record<string, never>, { groups: string[] }>({ function_id: 'state::list_groups', payload: {} })
    if (!response || !Array.isArray(response.groups) || response.groups.some(scope => typeof scope !== 'string' || !scope.trim())) throw new Error('Invalid state::list_groups response')
    return [...new Set(response.groups)]
  }

  async list<T = unknown>(scope: string, options?: { includeDeleted?: boolean }): Promise<T[]> {
    const rows = await this.sdk.trigger<{ scope: string }, T[]>({ function_id: 'state::list', payload: { scope } })
    return scope.startsWith(OBS) && !options?.includeDeleted ? rows.filter(row => !isDeletedObservation(row)) : rows
  }
}
