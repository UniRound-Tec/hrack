import { Bot } from 'lucide-react'
import Antigravity from '@lobehub/icons/es/Antigravity/components/Mono'
import ClaudeCode from '@lobehub/icons/es/ClaudeCode/components/Mono'
import CodeBuddy from '@lobehub/icons/es/CodeBuddy/components/Mono'
import Codex from '@lobehub/icons/es/Codex/components/Mono'
import Cursor from '@lobehub/icons/es/Cursor/components/Mono'
import GeminiCLI from '@lobehub/icons/es/GeminiCLI/components/Mono'
import Grok from '@lobehub/icons/es/Grok/components/Mono'
import Kimi from '@lobehub/icons/es/Kimi/components/Mono'
import Junie from '@lobehub/icons/es/Junie/components/Mono'
import KiloCode from '@lobehub/icons/es/KiloCode/components/Mono'
import LobeHub from '@lobehub/icons/es/LobeHub/components/Mono'
import Mistral from '@lobehub/icons/es/Mistral/components/Mono'
import OpenCode from '@lobehub/icons/es/OpenCode/components/Mono'
import Pi from '@lobehub/icons/es/Pi/components/Mono'
import Qoder from '@lobehub/icons/es/Qoder/components/Mono'
import Trae from '@lobehub/icons/es/Trae/components/Mono'
import type { ComponentType, SVGProps } from 'react'

export type BrandIcon = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string }
>

const adapterIcons: Record<string, BrandIcon> = {
  dsh: Bot,
  antigravity: Antigravity,
  codex: Codex,
  'claude-code': ClaudeCode,
  'cursor-agent': Cursor,
  gemini: GeminiCLI,
  opencode: OpenCode,
  kimi: Kimi,
  grok: Grok,
  pi: Pi,
  'mistral-vibe': Mistral,
  junie: Junie,
  qoder: Qoder,
  'codebuddy-code': CodeBuddy,
  kilo: KiloCode,
  'trae-agent': Trae,
  aider: LobeHub,
  'warp-agent': LobeHub,
  continue: LobeHub
}

export function getAdapterIcon(adapterId: string): BrandIcon {
  return adapterIcons[adapterId] ?? LobeHub
}

/** 历史事件等场景显示的 CLI 名称（原型中与图标成对出现）。 */
const adapterNames: Record<string, string> = {
  dsh: 'DeepSeek Harness',
  antigravity: 'Antigravity CLI',
  codex: 'Codex',
  'claude-code': 'Claude Code',
  'cursor-agent': 'Cursor Agent',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
  kimi: 'Kimi Code',
  grok: 'Grok Build',
  pi: 'Pi',
  'factory-droid': 'Factory Droid',
  auggie: 'Auggie',
  'mistral-vibe': 'Mistral Vibe',
  junie: 'Junie',
  qoder: 'Qoder CLI',
  'codebuddy-code': 'CodeBuddy Code',
  kilo: 'Kilo Code',
  'trae-agent': 'Trae Agent',
  aider: 'Aider',
  'warp-agent': 'Warp Agent',
  continue: 'Continue'
}

export function getAdapterName(adapterId: string): string {
  return adapterNames[adapterId] ?? adapterId
}
