import { randomUUID } from 'node:crypto'
import type { CliInstallation, CliScanReport } from '../../shared/ipc-contract'
import {
  MODEL_ID_PATTERN,
  SEND_TEXT_LIMIT_BYTES,
  SESSION_NAME_LIMIT,
  type BridgeAgent,
  type BridgeBlocked,
  type BridgeCreateResult,
  type BridgeDelta,
  type BridgeLaunchRequest,
  type BridgeModelsResult,
  type BridgeRuntime,
  type BridgeSessionInfo,
  type BridgeTurnResult,
  type BridgeWatchEvent
} from '../../shared/bridge-protocol'
import type {
  AgentSessionPhase,
  AgentSessionRecord
} from '../agents/AgentSessionRuntime'
import type { ObserverControl } from '../agents/adapters/types'
import {
  collectKeys,
  cursorBeforeLastTurn,
  emptyCursor,
  extractLastClosedTurn,
  extractSinceCursor,
  parseOpenCodeMessages,
  type MessageCursor
} from '../agents/adapters/opencode/OpenCodeMessages'
import { byteLength, emptyDelta, isEmptyDelta, truncateDelta } from './delta'
import { BridgeError } from './errors'
import { parseOpenCodeModelsOutput } from './models'
import type { BridgeStateStore } from './state'

const MODELS_TIMEOUT_MS = 15_000
const CREATE_TIMEOUT_MS = 45_000
const CREATE_POLL_MS = 100
const SNAPSHOT_RETRIES = 3
const SNAPSHOT_RETRY_MS = 150

export interface ControlPlaneDiscovery {
  scan(force?: boolean): Promise<CliScanReport>
  resolveInstallation(installationId: string): Promise<CliInstallation | null>
  resolveWorkspace(installationId: string, workspace: string): Promise<string>
  runInstallationCommand(
    installation: CliInstallation,
    args: readonly string[],
    timeoutMs?: number
  ): Promise<{
    stdout: string
    stderr: string
    timedOut: boolean
    code: number | null
  }>
}

export interface ControlPlaneRuntime {
  getRecord(sessionId: string): AgentSessionRecord | null
  listRecords(): AgentSessionRecord[]
  subscribe(
    listener: (record: AgentSessionRecord, phase: AgentSessionPhase) => void
  ): () => void
  observerControl(sessionId: string): ObserverControl | undefined
  stop(sessionId: string): Promise<void>
  rename(sessionId: string, name: string): { name?: string } | null
  setAgent(sessionId: string, agent: BridgeAgent): void
}

export interface OpenCodeControlPlaneDeps {
  discovery: ControlPlaneDiscovery
  runtime: ControlPlaneRuntime
  state: BridgeStateStore
  requireForegroundWindow(): void
  launchVisible(request: BridgeLaunchRequest): Promise<string | null>
  now?: () => number
}

export type WatchHandler = (event: BridgeWatchEvent) => void

interface WatchSubscriber {
  sessionId: string
  emit: WatchHandler
  close: (error?: Error) => void
  cursor: MessageCursor
  lastBlockedKey: string | null
  hadActivity: boolean
  closed: boolean
  busy: boolean
  pending: { record: AgentSessionRecord; phase: AgentSessionPhase } | null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function asAgent(value: unknown): BridgeAgent {
  if (value === undefined || value === null || value === '') return 'build'
  if (value === 'build' || value === 'plan') return value
  throw BridgeError.invalid('agent must be build or plan')
}

function requiredAgent(value: unknown): BridgeAgent {
  if (value === 'build' || value === 'plan') return value
  throw BridgeError.invalid('agent must be build or plan')
}

function parseApprovalRequestId(
  requestId: string
): { nativeSessionId: string; nativePermissionId: string } | null {
  const match = /^opencode:(.+):approval:(.+)$/.exec(requestId)
  return match
    ? { nativeSessionId: match[1], nativePermissionId: match[2] }
    : null
}

function parseInputRequestId(
  requestId: string
): { nativeSessionId: string; nativeQuestionId: string } | null {
  const match = /^opencode:(.+):input:(.+)$/.exec(requestId)
  return match
    ? { nativeSessionId: match[1], nativeQuestionId: match[2] }
    : null
}

function isHttpMissing(error: unknown): boolean {
  if (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    (error as { status?: number }).status === 404
  ) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /HTTP 404|not found/i.test(message)
}

function questionSummary(item: Record<string, unknown>): string | undefined {
  const questions = Array.isArray(item.questions) ? item.questions : []
  const first = questions[0]
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const record = first as Record<string, unknown>
    if (typeof record.header === 'string' && record.header.trim()) {
      return record.header.trim()
    }
    if (typeof record.question === 'string' && record.question.trim()) {
      return record.question.trim()
    }
  }
  if (typeof item.summary === 'string' && item.summary.trim()) return item.summary
  if (typeof item.prompt === 'string' && item.prompt.trim()) return item.prompt
  return undefined
}

type WaitUntil = 'blocked' | 'turn' | 'exited'

function asWaitUntil(value: unknown): WaitUntil {
  if (value === 'blocked' || value === 'turn' || value === 'exited') return value
  throw BridgeError.invalid('until must be blocked, turn, or exited')
}

function matchesWait(type: BridgeWatchEvent['type'], until: WaitUntil): boolean {
  if (until === 'blocked') return type === 'blocked'
  if (until === 'turn') return type === 'turn'
  return type === 'exited' || type === 'failed'
}

function boundedName(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'OpenCode'
  if (typeof value !== 'string') throw BridgeError.invalid('name must be a string')
  const name = value.trim().replace(/[\u0000-\u001f\u007f]/g, '')
  if (!name) return 'OpenCode'
  if (name.length > SESSION_NAME_LIMIT) {
    throw BridgeError.invalid(`name must be 1–${SESSION_NAME_LIMIT} characters`)
  }
  return name
}

function describeBlocked(record: AgentSessionRecord): BridgeBlocked {
  const approvals = Object.entries(record.projection.correlation.pendingApprovals)
  if (approvals[0]) {
    const [requestId, info] = approvals[0]
    return {
      kind: 'permission',
      requestId,
      summary: info.summary ?? info.category
    }
  }
  const inputs = Object.entries(record.projection.correlation.pendingInputs)
  if (inputs[0]) {
    const [requestId, info] = inputs[0]
    return {
      kind: 'question',
      requestId,
      summary: info.prompt,
      form: info.prompt ? { prompt: info.prompt } : undefined
    }
  }
  return { kind: 'other', summary: record.projection.detail }
}

function runtimeOf(installation: CliInstallation): BridgeRuntime {
  return installation.runtime
}

export class OpenCodeControlPlane {
  private readonly lastClosedTurns = new Map<string, BridgeDelta>()
  private readonly watches = new Map<string, Set<WatchSubscriber>>()
  private readonly unsubscribe: () => void
  private readonly now: () => number

  constructor(private readonly deps: OpenCodeControlPlaneDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.unsubscribe = deps.runtime.subscribe((record, phase) => {
      if (record.adapterId === 'opencode') {
        void this.deps.state.rememberInstallation(record.installationId)
      }
      void this.dispatchWatch(record, phase)
    })
  }

  dispose(): void {
    this.unsubscribe()
    for (const subscribers of this.watches.values()) {
      for (const subscriber of subscribers) {
        if (!subscriber.closed) subscriber.close()
      }
    }
    this.watches.clear()
    this.lastClosedTurns.clear()
  }

  async handle(
    method: string,
    params: unknown
  ): Promise<{ kind: 'json'; value: unknown } | { kind: 'watch'; sessionId: string }> {
    switch (method) {
      case 'opencode.models':
        return { kind: 'json', value: await this.models(params) }
      case 'opencode.create':
        return { kind: 'json', value: await this.create(params) }
      case 'sessions.list':
        return { kind: 'json', value: await this.sessions() }
      case 'session.send':
        return { kind: 'json', value: await this.send(params) }
      case 'session.turn':
        return { kind: 'json', value: await this.turn(params) }
      case 'session.watch':
        return { kind: 'watch', sessionId: this.watchSessionId(params) }
      case 'session.close':
        return { kind: 'json', value: await this.close(params) }
      case 'session.rename':
        return { kind: 'json', value: await this.rename(params) }
      case 'session.mode':
        return { kind: 'json', value: await this.mode(params) }
      case 'session.approve':
        return { kind: 'json', value: await this.approve(params) }
      case 'session.deny':
        return { kind: 'json', value: await this.deny(params) }
      case 'session.questions':
        return { kind: 'json', value: await this.questions(params) }
      case 'session.answer':
        return { kind: 'json', value: await this.answer(params) }
      case 'session.reject-question':
        return { kind: 'json', value: await this.rejectQuestion(params) }
      case 'session.wait':
        return { kind: 'json', value: await this.wait(params) }
      default:
        throw BridgeError.invalid(`Unknown method: ${method}`)
    }
  }

  watch(
    sessionId: string,
    emit: WatchHandler,
    close: (error?: Error) => void
  ): () => void {
    const record = this.requireOpenCode(sessionId)
    const subscriber: WatchSubscriber = {
      sessionId,
      emit,
      close,
      cursor: emptyCursor(),
      lastBlockedKey: null,
      hadActivity: record.projection.status === 'working',
      closed: false,
      busy: false,
      pending: null
    }
    let set = this.watches.get(sessionId)
    if (!set) {
      set = new Set()
      this.watches.set(sessionId, set)
    }
    set.add(subscriber)
    queueMicrotask(() => {
      void this.primeWatch(subscriber)
    })
    return () => {
      subscriber.closed = true
      set?.delete(subscriber)
      if (set && set.size === 0) this.watches.delete(sessionId)
    }
  }

  private watchSessionId(params: unknown): string {
    const sessionId = this.stringParam(params, 'sessionId', true)
    this.requireOpenCode(sessionId)
    return sessionId
  }

  async models(params: unknown): Promise<BridgeModelsResult> {
    const installation = await this.resolveOpenCodeInstallation(
      this.optionalString(params, 'installationId')
    )
    const result = await this.deps.discovery.runInstallationCommand(
      installation,
      ['models'],
      MODELS_TIMEOUT_MS
    )
    if (result.timedOut) {
      throw BridgeError.timeout('opencode models timed out')
    }
    if (result.code !== 0 && result.code !== null && result.stdout.trim() === '') {
      throw BridgeError.unavailable(
        result.stderr.trim() || 'opencode models failed'
      )
    }
    return {
      installationId: installation.id,
      runtime: runtimeOf(installation),
      models: parseOpenCodeModelsOutput(result.stdout)
    }
  }

  async create(params: unknown): Promise<BridgeCreateResult> {
    const workspaceInput = this.stringParam(params, 'workspace', true)
    const model = this.stringParam(params, 'model', true)
    const agent = asAgent(this.optionalString(params, 'agent'))
    const name = boundedName(this.optionalString(params, 'name'))
    if (!MODEL_ID_PATTERN.test(model)) {
      throw BridgeError.invalid(`Invalid model id: ${model}`)
    }

    const installation = await this.resolveOpenCodeInstallation(
      this.optionalString(params, 'installationId')
    )
    const listed = await this.models({ installationId: installation.id })
    if (listed.models.length === 0) {
      throw BridgeError.unavailable(
        'No OpenCode models available; run /connect in OpenCode first'
      )
    }
    if (!listed.models.some((item) => item.id === model)) {
      throw BridgeError.invalid(`Model is not in the installation list: ${model}`)
    }

    const workspace = await this.deps.discovery.resolveWorkspace(
      installation.id,
      workspaceInput
    )
    this.deps.requireForegroundWindow()

    const terminalId = randomUUID()
    const requestId = randomUUID()
    const args = [workspace, '-m', model, '--agent', agent]
    const launchError = await this.deps.launchVisible({
      requestId,
      terminalId,
      name,
      workspace,
      selection: {
        installationId: installation.id,
        workspace,
        args
      }
    })
    if (launchError) throw BridgeError.unavailable(launchError)

    const startedAt = this.now()
    let record: AgentSessionRecord | null = null
    while (this.now() - startedAt < CREATE_TIMEOUT_MS) {
      record =
        this.deps.runtime
          .listRecords()
          .find((item) => item.terminalId === terminalId) ?? null
      if (record) break
      await sleep(CREATE_POLL_MS)
    }
    if (!record) {
      throw BridgeError.unavailable(
        'Timed out waiting for the OpenCode tab to register'
      )
    }
    await this.deps.state.rememberInstallation(installation.id)
    return {
      sessionId: record.sessionId,
      terminalId: record.terminalId,
      name: record.name || name,
      model,
      agent,
      workspace: record.workspace,
      installationId: installation.id,
      runtime: runtimeOf(installation)
    }
  }

  async close(params: unknown): Promise<{ sessionId: string; closed: true }> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    this.requireOpenCode(sessionId)
    await this.deps.runtime.stop(sessionId)
    this.lastClosedTurns.delete(sessionId)
    return { sessionId, closed: true }
  }

  async rename(params: unknown): Promise<{
    sessionId: string
    name: string
    titleUpdated: boolean
    error?: { message: string }
  }> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    const name = this.requiredName(params)
    this.requireOpenCode(sessionId)
    const renamed = this.deps.runtime.rename(sessionId, name)
    if (!renamed) throw BridgeError.invalid('Could not rename session')
    let titleUpdated = false
    let error: { message: string } | undefined
    const control = this.deps.runtime.observerControl(sessionId)
    if (!control?.setTitle) {
      error = {
        message: 'OpenCode session is not controllable; TUI is still available'
      }
    } else {
      try {
        await control.setTitle(name)
        titleUpdated = true
      } catch (caught) {
        error = {
          message: caught instanceof Error ? caught.message : String(caught)
        }
      }
    }
    return {
      sessionId,
      name: renamed.name || name,
      titleUpdated,
      ...(error ? { error } : {})
    }
  }

  async mode(
    params: unknown
  ): Promise<{ sessionId: string; agent: BridgeAgent }> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    const agent = requiredAgent(this.optionalString(params, 'agent'))
    const record = this.requireOpenCode(sessionId)
    if (record.projection.status === 'exited') {
      throw BridgeError.notAllowed('Cannot change mode on an exited session')
    }
    const control = this.requireControl(sessionId)
    if (!control.setAgent) {
      throw BridgeError.uncontrolled(
        'OpenCode has no write API to set plan/build; TUI is still available'
      )
    }
    try {
      await control.setAgent(agent)
    } catch (error) {
      throw BridgeError.uncontrolled(
        error instanceof Error ? error.message : String(error)
      )
    }
    this.deps.runtime.setAgent(sessionId, agent)
    return { sessionId, agent }
  }

  async approve(params: unknown): Promise<{
    sessionId: string
    requestId: string
    decision: 'approved'
    remember: boolean
    already?: true
  }> {
    return this.respondApproval(params, 'approved')
  }

  async deny(params: unknown): Promise<{
    sessionId: string
    requestId: string
    decision: 'denied'
    remember: boolean
    already?: true
  }> {
    return this.respondApproval(params, 'denied')
  }

  async questions(params: unknown): Promise<{
    sessionId: string
    questions: Array<{ requestId: string; summary?: string; form?: unknown }>
  }> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    const record = this.requireOpenCode(sessionId)
    const control = this.deps.runtime.observerControl(sessionId)
    if (control?.listQuestions) {
      try {
        const listed = await control.listQuestions()
        const items = Array.isArray(listed) ? listed : []
        if (items.length > 0) {
          return {
            sessionId,
            questions: items.map((item) => this.toQuestionInfo(item))
          }
        }
      } catch {
        // Fall back to the projection if the official list route is missing.
      }
    }
    return {
      sessionId,
      questions: Object.entries(record.projection.correlation.pendingInputs).map(
        ([requestId, info]) => ({
          requestId,
          summary: info.prompt,
          form: info.prompt ? { prompt: info.prompt } : undefined
        })
      )
    }
  }

  async answer(params: unknown): Promise<{
    sessionId: string
    requestId: string
    answered: true
    already?: true
  }> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    const requestId = this.stringParam(params, 'requestId', true)
    const record = this.requireOpenCode(sessionId)
    const parsed = parseInputRequestId(requestId)
    if (!parsed) throw BridgeError.invalid('requestId is not a question id')
    const payload = this.parseAnswerJson(params)
    if (!record.projection.correlation.pendingInputs[requestId]) {
      return { sessionId, requestId, answered: true, already: true }
    }
    const control = this.requireControl(sessionId)
    if (!control.answerQuestion) {
      throw BridgeError.uncontrolled(
        'OpenCode session is not controllable; TUI is still available'
      )
    }
    try {
      await control.answerQuestion(parsed.nativeQuestionId, payload)
    } catch (error) {
      if (isHttpMissing(error)) {
        return { sessionId, requestId, answered: true, already: true }
      }
      throw BridgeError.uncontrolled(
        error instanceof Error ? error.message : String(error)
      )
    }
    return { sessionId, requestId, answered: true }
  }

  async rejectQuestion(params: unknown): Promise<{
    sessionId: string
    requestId: string
    rejected: true
    already?: true
  }> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    const requestId = this.stringParam(params, 'requestId', true)
    const record = this.requireOpenCode(sessionId)
    const parsed = parseInputRequestId(requestId)
    if (!parsed) throw BridgeError.invalid('requestId is not a question id')
    if (!record.projection.correlation.pendingInputs[requestId]) {
      return { sessionId, requestId, rejected: true, already: true }
    }
    const control = this.requireControl(sessionId)
    if (!control.rejectQuestion) {
      throw BridgeError.uncontrolled(
        'OpenCode session is not controllable; TUI is still available'
      )
    }
    try {
      await control.rejectQuestion(parsed.nativeQuestionId)
    } catch (error) {
      if (isHttpMissing(error)) {
        return { sessionId, requestId, rejected: true, already: true }
      }
      throw BridgeError.uncontrolled(
        error instanceof Error ? error.message : String(error)
      )
    }
    return { sessionId, requestId, rejected: true }
  }

  async wait(params: unknown): Promise<BridgeWatchEvent> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    const until = asWaitUntil(this.optionalString(params, 'until') ?? 'turn')
    this.requireOpenCode(sessionId)
    return new Promise<BridgeWatchEvent>((resolve, reject) => {
      let settled = false
      const stop = this.watch(
        sessionId,
        (event) => {
          if (!matchesWait(event.type, until)) return
          if (settled) return
          settled = true
          stop()
          resolve(event)
        },
        (error) => {
          if (settled) return
          settled = true
          stop()
          reject(
            error
              ? BridgeError.unavailable(
                  error instanceof Error ? error.message : String(error)
                )
              : BridgeError.unavailable('Watch closed before a matching event')
          )
        }
      )
    })
  }

  async sessions(): Promise<BridgeSessionInfo[]> {
    return this.deps.runtime
      .listRecords()
      .filter((record) => record.adapterId === 'opencode')
      .map((record) => this.toSessionInfo(record))
  }

  async send(params: unknown): Promise<{ accepted: true }> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    const text = this.stringParam(params, 'text', true)
    const agentRaw = this.optionalString(params, 'agent')
    const agent = agentRaw ? asAgent(agentRaw) : undefined
    if (byteLength(text) > SEND_TEXT_LIMIT_BYTES) {
      throw BridgeError.invalid('send text exceeds 64 KiB')
    }
    const record = this.requireOpenCode(sessionId)
    const status = record.projection.status
    if (status !== 'idle' && status !== 'done') {
      throw BridgeError.notAllowed(
        `Cannot send while session is ${status}`
      )
    }
    const control = this.requireControl(sessionId)
    try {
      await control.submitPrompt(text, agent)
    } catch (error) {
      throw BridgeError.uncontrolled(
        error instanceof Error ? error.message : String(error)
      )
    }
    return { accepted: true }
  }

  async turn(params: unknown): Promise<BridgeTurnResult> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    const record = this.requireOpenCode(sessionId)
    const cached = this.lastClosedTurns.get(sessionId)
    const delta = cached ?? (await this.snapshotClosedTurn(record))
    return {
      sessionId,
      installationId: record.installationId,
      runtime: record.runtime,
      delta
    }
  }

  private async snapshotClosedTurn(
    record: AgentSessionRecord
  ): Promise<BridgeDelta> {
    const control = this.deps.runtime.observerControl(record.sessionId)
    if (!control) return emptyDelta()
    try {
      const messages = parseOpenCodeMessages(await control.snapshotMessages())
      const delta = extractLastClosedTurn(messages)
      this.lastClosedTurns.set(record.sessionId, delta)
      return delta
    } catch {
      return this.lastClosedTurns.get(record.sessionId) ?? emptyDelta()
    }
  }

  private async dispatchWatch(
    record: AgentSessionRecord,
    phase: AgentSessionPhase
  ): Promise<void> {
    const subscribers = this.watches.get(record.sessionId)
    if (!subscribers || subscribers.size === 0) {
      if (phase === 'finalized') this.lastClosedTurns.delete(record.sessionId)
      return
    }
    for (const subscriber of [...subscribers]) {
      if (subscriber.closed) continue
      await this.enqueueWatch(subscriber, record, phase)
    }
    if (phase === 'finalized') this.lastClosedTurns.delete(record.sessionId)
  }

  private async primeWatch(subscriber: WatchSubscriber): Promise<void> {
    const current = this.deps.runtime.getRecord(subscriber.sessionId)
    if (!current || subscriber.closed) return
    const control = this.deps.runtime.observerControl(current.sessionId)
    if (control) {
      try {
        const messages = parseOpenCodeMessages(await control.snapshotMessages())
        const status = current.projection.status
        subscriber.cursor =
          subscriber.hadActivity ||
          status === 'working' ||
          status === 'needs-you' ||
          status === 'done'
            ? cursorBeforeLastTurn(messages)
            : { keys: collectKeys(messages) }
      } catch {
        // Keep an empty cursor; the first emit will retry the snapshot.
      }
    }
    if (!subscriber.closed) {
      await this.enqueueWatch(subscriber, current, 'updated')
    }
  }

  private async enqueueWatch(
    subscriber: WatchSubscriber,
    record: AgentSessionRecord,
    phase: AgentSessionPhase
  ): Promise<void> {
    subscriber.pending = { record, phase }
    if (subscriber.busy) return
    subscriber.busy = true
    try {
      while (subscriber.pending && !subscriber.closed) {
        const next = subscriber.pending
        subscriber.pending = null
        await this.advanceWatch(subscriber, next.record, next.phase)
      }
    } finally {
      subscriber.busy = false
    }
  }

  private async advanceWatch(
    subscriber: WatchSubscriber,
    record: AgentSessionRecord,
    phase: AgentSessionPhase
  ): Promise<void> {
    const status = record.projection.status
    if (status === 'working') {
      subscriber.hadActivity = true
      return
    }
    if (phase === 'finalized' || status === 'exited') {
      const snap = await this.snapshotForWatch(subscriber, record, 'tail')
      this.emitWatch(subscriber, record, {
        type: 'exited',
        status: 'exited',
        delta: snap.delta
      })
      subscriber.closed = true
      subscriber.close()
      this.watches.get(record.sessionId)?.delete(subscriber)
      return
    }
    if (status === 'needs-you') {
      const blocked = describeBlocked(record)
      const key = `${blocked.kind}:${blocked.requestId ?? ''}`
      if (subscriber.lastBlockedKey === key) return
      subscriber.lastBlockedKey = key
      const snap = await this.snapshotForWatch(subscriber, record, 'required')
      if (snap.failed) {
        subscriber.lastBlockedKey = null
        this.emitWatch(subscriber, record, {
          type: 'failed',
          status: 'error',
          delta: snap.delta,
          error: { message: snap.error }
        })
        return
      }
      this.emitWatch(subscriber, record, {
        type: 'blocked',
        status: 'needs-you',
        delta: snap.delta,
        blocked
      })
      return
    }
    if (status === 'error') {
      const snap = await this.snapshotForWatch(subscriber, record, 'tail')
      this.emitWatch(subscriber, record, {
        type: 'failed',
        status: 'error',
        delta: snap.delta,
        error: {
          message:
            record.projection.correlation.turnFailedMessage ??
            record.projection.detail ??
            'OpenCode turn failed'
        }
      })
      subscriber.lastBlockedKey = null
      return
    }
    if (
      (status === 'done' ||
        (status === 'idle' && record.projection.statusConfidence === 'high')) &&
      subscriber.hadActivity
    ) {
      const savedCursor = subscriber.cursor
      const snap = await this.snapshotForWatch(subscriber, record, 'required')
      if (snap.failed) {
        this.emitWatch(subscriber, record, {
          type: 'failed',
          status: 'error',
          delta: snap.delta,
          error: { message: snap.error }
        })
        subscriber.hadActivity = false
        subscriber.lastBlockedKey = null
        return
      }
      if (status === 'idle' && isEmptyDelta(snap.delta)) {
        subscriber.cursor = savedCursor
        return
      }
      this.emitWatch(subscriber, record, {
        type: 'turn',
        status: status === 'idle' ? 'idle' : 'done',
        delta: snap.delta
      })
      subscriber.hadActivity = false
      subscriber.lastBlockedKey = null
    }
  }

  private emitWatch(
    subscriber: WatchSubscriber,
    record: AgentSessionRecord,
    event: Omit<
      BridgeWatchEvent,
      'v' | 'sessionId' | 'installationId' | 'runtime' | 'occurredAt'
    >
  ): void {
    if (subscriber.closed) return
    subscriber.emit({
      v: 1,
      sessionId: record.sessionId,
      installationId: record.installationId,
      runtime: record.runtime,
      occurredAt: this.now(),
      ...event
    })
  }

  private async snapshotForWatch(
    subscriber: WatchSubscriber,
    record: AgentSessionRecord,
    mode: 'required' | 'tail'
  ): Promise<{ delta: BridgeDelta; failed: boolean; error: string }> {
    const control = this.deps.runtime.observerControl(record.sessionId)
    if (!control) {
      return {
        delta: emptyDelta(),
        failed: mode === 'required',
        error: 'OpenCode session is not controllable; TUI is still available'
      }
    }
    let lastError = 'snapshot failed'
    for (let attempt = 0; attempt < SNAPSHOT_RETRIES; attempt++) {
      try {
        const messages = parseOpenCodeMessages(await control.snapshotMessages())
        this.lastClosedTurns.set(record.sessionId, extractLastClosedTurn(messages))
        const extracted = extractSinceCursor(messages, subscriber.cursor)
        subscriber.cursor = extracted.cursor
        const delta = truncateDelta(extracted.delta)
        if (
          mode === 'required' &&
          isEmptyDelta(delta) &&
          extractLastClosedTurn(messages).text.length === 0 &&
          extractLastClosedTurn(messages).tools.length === 0
        ) {
          return { delta, failed: false, error: '' }
        }
        return { delta, failed: false, error: '' }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        if (attempt < SNAPSHOT_RETRIES - 1) await sleep(SNAPSHOT_RETRY_MS)
      }
    }
    return {
      delta: emptyDelta(),
      failed: true,
      error: lastError
    }
  }

  private async resolveOpenCodeInstallation(
    installationId: string | undefined
  ): Promise<CliInstallation> {
    const report = await this.deps.discovery.scan(false)
    const installations = report.launchable
      .filter((cli) => cli.definition.id === 'opencode')
      .flatMap((cli) => cli.installations)
    if (installationId) {
      const found =
        installations.find((item) => item.id === installationId) ??
        (await this.deps.discovery.resolveInstallation(installationId))
      if (!found || found.definitionId !== 'opencode') {
        throw BridgeError.notFound(
          `OpenCode installation not found: ${installationId}`
        )
      }
      return found
    }
    const remembered = await this.deps.state.lastInstallationId()
    if (remembered) {
      const found = installations.find((item) => item.id === remembered)
      if (found) return found
    }
    if (installations.length === 1) return installations[0]
    if (installations.length === 0) {
      throw BridgeError.unavailable(
        'No OpenCode installation found; install OpenCode and rescan'
      )
    }
    const listed = installations
      .map((item) => {
        const runtime =
          item.runtime.kind === 'wsl'
            ? `wsl:${item.runtime.distro}`
            : `host:${item.runtime.platform}`
        return `${item.id} (${runtime})`
      })
      .join(', ')
    throw BridgeError.invalid(
      `Multiple OpenCode installations; pass --installation. Available: ${listed}`
    )
  }

  private requireOpenCode(sessionId: string): AgentSessionRecord {
    const record = this.deps.runtime.getRecord(sessionId)
    if (!record || record.adapterId !== 'opencode') {
      throw BridgeError.notFound(`OpenCode session not found: ${sessionId}`)
    }
    return record
  }

  private requireControl(sessionId: string): ObserverControl {
    const control = this.deps.runtime.observerControl(sessionId)
    if (!control) {
      throw BridgeError.uncontrolled(
        'OpenCode session is not controllable; TUI is still available'
      )
    }
    return control
  }

  private toSessionInfo(record: AgentSessionRecord): BridgeSessionInfo {
    return {
      sessionId: record.sessionId,
      terminalId: record.terminalId,
      name: record.name || 'OpenCode',
      status: record.projection.status,
      agent: record.agent,
      model: record.model,
      workspace: record.workspace,
      installationId: record.installationId,
      runtime: record.runtime,
      pendingAttentionCount: record.projection.pendingAttentionCount
    }
  }

  private async respondApproval<D extends 'approved' | 'denied'>(
    params: unknown,
    decision: D
  ): Promise<{
    sessionId: string
    requestId: string
    decision: D
    remember: boolean
    already?: true
  }> {
    const sessionId = this.stringParam(params, 'sessionId', true)
    const requestId = this.stringParam(params, 'requestId', true)
    const remember =
      decision === 'approved' ? this.booleanParam(params, 'remember') : false
    const record = this.requireOpenCode(sessionId)
    const parsed = parseApprovalRequestId(requestId)
    if (!parsed) throw BridgeError.invalid('requestId is not a permission id')
    if (!record.projection.correlation.pendingApprovals[requestId]) {
      return { sessionId, requestId, decision, remember, already: true }
    }
    const control = this.requireControl(sessionId)
    if (!control.respondPermission) {
      throw BridgeError.uncontrolled(
        'OpenCode session is not controllable; TUI is still available'
      )
    }
    const response =
      decision === 'denied' ? 'reject' : remember ? 'always' : 'once'
    try {
      await control.respondPermission(parsed.nativePermissionId, response)
    } catch (error) {
      if (isHttpMissing(error)) {
        return { sessionId, requestId, decision, remember, already: true }
      }
      throw BridgeError.uncontrolled(
        error instanceof Error ? error.message : String(error)
      )
    }
    return { sessionId, requestId, decision, remember }
  }

  private toQuestionInfo(item: unknown): {
    requestId: string
    summary?: string
    form?: unknown
  } {
    const record = item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : {}
    const nativeId =
      typeof record.id === 'string' && record.id
        ? record.id
        : typeof record.requestID === 'string'
          ? record.requestID
          : ''
    const nativeSession =
      typeof record.sessionID === 'string' && record.sessionID
        ? record.sessionID
        : 'unknown'
    const requestId = nativeId
      ? `opencode:${nativeSession}:input:${nativeId}`
      : `opencode:${nativeSession}:input:unknown`
    return {
      requestId,
      summary: questionSummary(record),
      form: item
    }
  }

  private requiredName(params: unknown): string {
    const value = this.stringParam(params, 'name', true)
    const name = value.trim().replace(/[\u0000-\u001f\u007f]/g, '')
    if (!name) throw BridgeError.invalid('name is required')
    if (name.length > SESSION_NAME_LIMIT) {
      throw BridgeError.invalid(`name must be 1–${SESSION_NAME_LIMIT} characters`)
    }
    return name
  }

  private parseAnswerJson(params: unknown): unknown {
    const raw = this.stringParam(params, 'json', true)
    if (byteLength(raw) > SEND_TEXT_LIMIT_BYTES) {
      throw BridgeError.invalid('answer JSON exceeds 64 KiB')
    }
    try {
      return JSON.parse(raw)
    } catch {
      throw BridgeError.invalid('answer --json must be valid JSON')
    }
  }

  private booleanParam(params: unknown, key: string): boolean {
    if (params === undefined || params === null) return false
    if (typeof params !== 'object' || Array.isArray(params)) {
      throw BridgeError.invalid('params must be an object')
    }
    const value = (params as Record<string, unknown>)[key]
    if (value === undefined || value === null || value === false || value === '') {
      return false
    }
    if (value === true) return true
    throw BridgeError.invalid(`${key} must be a boolean`)
  }

  private optionalString(
    params: unknown,
    key: string
  ): string | undefined {
    if (params === undefined || params === null) return undefined
    if (typeof params !== 'object' || Array.isArray(params)) {
      throw BridgeError.invalid('params must be an object')
    }
    const value = (params as Record<string, unknown>)[key]
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string') throw BridgeError.invalid(`${key} must be a string`)
    return value
  }

  private stringParam(
    params: unknown,
    key: string,
    required: true
  ): string {
    const value = this.optionalString(params, key)
    if (!value) throw BridgeError.invalid(`${key} is required`)
    return value
  }
}
