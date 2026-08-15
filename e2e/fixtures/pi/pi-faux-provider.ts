import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall
} from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/** Deterministic, offline provider used only by the opt-in real Pi E2E. */
export default function registerHRackPiE2eProvider(pi: ExtensionAPI): void {
  const faux = createFauxCore({
    provider: 'hrack-e2e',
    api: 'hrack-e2e',
    tokensPerSecond: 24,
    models: [
      {
        id: 'trace',
        name: 'HRack E2E Trace',
        reasoning: true,
        input: ['text'],
        contextWindow: 16_384,
        maxTokens: 2_048
      }
    ]
  })
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxThinking(
          'Verify that Pi emits a reasoning phase before running the deterministic test command.'
        ),
        fauxToolCall('bash', {
          command: 'node -e "console.log(\'PI_TOOL_OK\')"'
        })
      ],
      { stopReason: 'toolUse' }
    ),
    fauxAssistantMessage([
      fauxThinking('Confirm the command completed and finish the turn.'),
      fauxText('PI_TRACE_OK')
    ]),
    fauxAssistantMessage(
      [
        fauxThinking('Run the deterministic failing command.'),
        fauxToolCall('bash', { command: 'node -e "process.exit(7)"' })
      ],
      { stopReason: 'toolUse' }
    ),
    fauxAssistantMessage('PI_FAILURE_RECOVERED'),
    fauxAssistantMessage('', {
      stopReason: 'error',
      errorMessage: 'offline deterministic retry'
    }),
    fauxAssistantMessage([
      fauxThinking('The retry succeeded; finish the same public run.'),
      fauxText('PI_RETRY_OK')
    ])
  ])
  // Pi 0.80 cannot consume the newer Provider object from fauxProvider().
  pi.registerProvider('hrack-e2e', {
    name: 'HRack E2E',
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'offline-e2e',
    api: faux.api,
    streamSimple: faux.streamSimple,
    models: faux.models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens
    }))
  })
}
