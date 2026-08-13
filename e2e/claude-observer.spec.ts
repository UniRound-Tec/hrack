import { expect, test } from '@playwright/test'
import { parseClaudeHook } from '../electron/agents/adapters/claude/ClaudeHookParser'
import { ClaudeHookProjector } from '../electron/agents/adapters/claude/ClaudeHookProjector'
import { CLAUDE_HOOK_CAPABILITIES } from '../electron/agents/adapters/claude/types'
import { projectAdapterEvents } from './helpers/agent-projection-contract'

test.describe('Claude observer adapter', () => {
  test('reconciles permission hooks on either side of the tool lifecycle', () => {
    const prompt = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-session-permission'
    }
    const permission = {
      hook_event_name: 'PermissionRequest',
      session_id: 'claude-session-permission',
      tool_name: 'Bash',
      tool_input: { command: 'echo safe-fixture' }
    }
    const beforeTool = {
      hook_event_name: 'PreToolUse',
      session_id: 'claude-session-permission',
      tool_use_id: 'tool-permission',
      tool_name: 'Bash',
      tool_input: { command: 'echo safe-fixture' }
    }
    const afterTool = {
      hook_event_name: 'PostToolUse',
      session_id: 'claude-session-permission',
      tool_use_id: 'tool-permission',
      tool_name: 'Bash',
      tool_input: { command: 'echo safe-fixture' }
    }

    for (const [scenario, sequence] of [
      [prompt, permission, beforeTool, afterTool],
      [prompt, beforeTool, afterTool, permission]
    ].entries()) {
      const facts = sequence.map(parseClaudeHook)
      expect(facts.every(Boolean)).toBe(true)
      const projector = new ClaudeHookProjector()
      const events = facts.flatMap((fact, index) =>
        projector.project(fact!, 4_000 + index)
      )

      const projection = projectAdapterEvents(events, {
        adapterId: 'claude-code',
        source: 'hook',
        capabilities: CLAUDE_HOOK_CAPABILITIES
      })

      expect(events.filter((event) => event.kind === 'approval.requested').length).toBeGreaterThanOrEqual(1)
      expect(events.filter((event) => event.kind === 'approval.resolved')).toHaveLength(0)
      expect(projection.status, `scenario ${scenario}`).toBe('working')
      expect(projection.pendingAttentionCount).toBe(0)
    }
  })

  test('does not guess an approval when parallel tools are ambiguous', () => {
    const payloads = [
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-parallel'
      },
      ...['tool-a', 'tool-b'].map((toolUseId) => ({
        hook_event_name: 'PreToolUse',
        session_id: 'claude-session-parallel',
        tool_use_id: toolUseId,
        tool_name: 'Bash',
        tool_input: { command: 'echo same-fixture' }
      })),
      {
        hook_event_name: 'PermissionRequest',
        session_id: 'claude-session-parallel',
        tool_name: 'Bash',
        tool_input: { command: 'echo same-fixture' }
      },
      ...['tool-a', 'tool-b'].map((toolUseId) => ({
        hook_event_name: 'PostToolUse',
        session_id: 'claude-session-parallel',
        tool_use_id: toolUseId,
        tool_name: 'Bash',
        tool_input: { command: 'echo same-fixture' }
      })),
      {
        hook_event_name: 'Stop',
        session_id: 'claude-session-parallel'
      }
    ]
    const facts = payloads.map(parseClaudeHook)
    expect(facts.every(Boolean)).toBe(true)
    const projector = new ClaudeHookProjector()
    const events = facts.flatMap((fact, index) =>
      projector.project(fact!, 5_000 + index)
    )

    const projection = projectAdapterEvents(events, {
      adapterId: 'claude-code',
      source: 'hook',
      capabilities: CLAUDE_HOOK_CAPABILITIES
    })
    expect(events.filter((event) => event.kind === 'approval.resolved')).toHaveLength(0)
    expect(projection.status).toBe('done')
    expect(projection.pendingAttentionCount).toBe(0)
  })

  test('does not reopen a completed turn for late tool or permission hooks', () => {
    const payloads = [
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-late'
      },
      {
        hook_event_name: 'PreToolUse',
        session_id: 'claude-session-late',
        tool_use_id: 'tool-late',
        tool_name: 'Bash',
        tool_input: { command: 'echo late' }
      },
      {
        hook_event_name: 'PostToolUse',
        session_id: 'claude-session-late',
        tool_use_id: 'tool-late',
        tool_name: 'Bash',
        tool_input: { command: 'echo late' }
      },
      {
        hook_event_name: 'Stop',
        session_id: 'claude-session-late'
      },
      {
        hook_event_name: 'PermissionRequest',
        session_id: 'claude-session-late',
        tool_name: 'Bash',
        tool_input: { command: 'echo late' }
      },
      {
        hook_event_name: 'PreToolUse',
        session_id: 'claude-session-late',
        tool_use_id: 'tool-after-stop',
        tool_name: 'Read',
        tool_input: { file_path: 'README.md' }
      }
    ]
    const facts = payloads.map(parseClaudeHook)
    expect(facts.every(Boolean)).toBe(true)
    const projector = new ClaudeHookProjector()
    const events = facts.flatMap((fact, index) =>
      projector.project(fact!, 6_000 + index)
    )
    const projection = projectAdapterEvents(events, {
      adapterId: 'claude-code',
      source: 'hook',
      capabilities: CLAUDE_HOOK_CAPABILITIES
    })

    expect(events.filter((event) => event.kind === 'turn.started')).toHaveLength(1)
    expect(projection.status).toBe('done')
    expect(projection.activeToolCount).toBe(0)
    expect(projection.pendingAttentionCount).toBe(0)
  })
})
