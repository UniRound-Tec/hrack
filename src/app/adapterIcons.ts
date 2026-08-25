import { Bot, GitMerge, Heart, Orbit, Sparkles } from 'lucide-react'
import Amp from '@lobehub/icons/es/Amp/components/Color'
import Antigravity from '@lobehub/icons/es/Antigravity/components/Color'
import ClaudeCode from '@lobehub/icons/es/ClaudeCode/components/Color'
import Cline from '@lobehub/icons/es/Cline/components/Mono'
import CodeBuddy from '@lobehub/icons/es/CodeBuddy/components/Color'
import Codex from '@lobehub/icons/es/Codex/components/Color'
import Cursor from '@lobehub/icons/es/Cursor/components/Mono'
import DeepSeek from '@lobehub/icons/es/DeepSeek/components/Color'
import Devin from '@lobehub/icons/es/Devin/components/Color'
import GeminiCLI from '@lobehub/icons/es/GeminiCLI/components/Color'
import GithubCopilot from '@lobehub/icons/es/GithubCopilot/components/Mono'
import Goose from '@lobehub/icons/es/Goose/components/Mono'
import Grok from '@lobehub/icons/es/Grok/components/Mono'
import Kimi from '@lobehub/icons/es/Kimi/components/Color'
import Kiro from '@lobehub/icons/es/Kiro/components/Color'
import Junie from '@lobehub/icons/es/Junie/components/Color'
import KiloCode from '@lobehub/icons/es/KiloCode/components/Mono'
import LobeHub from '@lobehub/icons/es/LobeHub/components/Color'
import Mistral from '@lobehub/icons/es/Mistral/components/Color'
import OpenCode from '@lobehub/icons/es/OpenCode/components/Mono'
import Pi from '@lobehub/icons/es/Pi/components/Mono'
import Qoder from '@lobehub/icons/es/Qoder/components/Color'
import Qwen from '@lobehub/icons/es/Qwen/components/Color'
import Trae from '@lobehub/icons/es/Trae/components/Color'
import type { ComponentType, SVGProps } from 'react'

export type BrandIcon = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string }
>

const adapterIcons: Record<string, BrandIcon> = {
  dsh: DeepSeek,
  antigravity: Antigravity,
  codex: Codex,
  'claude-code': ClaudeCode,
  'cursor-agent': Cursor,
  cline: Cline,
  qwen: Qwen,
  amp: Amp,
  gemini: GeminiCLI,
  opencode: OpenCode,
  kimi: Kimi,
  grok: Grok,
  pi: Pi,
  copilot: GithubCopilot,
  goose: Goose,
  crush: Heart,
  'warp-agent': Orbit,
  devin: Devin,
  kiro: Kiro,
  'mistral-vibe': Mistral,
  junie: Junie,
  qoder: Qoder,
  'codebuddy-code': CodeBuddy,
  kilo: KiloCode,
  'trae-agent': Trae,
  aider: GitMerge,
  'factory-droid': Bot,
  auggie: Sparkles,
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
  cline: 'Cline',
  qwen: 'Qwen Code',
  amp: 'Amp',
  copilot: 'GitHub Copilot CLI',
  goose: 'Goose',
  crush: 'Crush',
  'warp-agent': 'Warp / Oz',
  devin: 'Devin CLI',
  kiro: 'Kiro CLI',
  'factory-droid': 'Factory Droid',
  auggie: 'Auggie',
  'mistral-vibe': 'Mistral Vibe',
  junie: 'Junie',
  qoder: 'Qoder CLI',
  'codebuddy-code': 'CodeBuddy Code',
  kilo: 'Kilo Code',
  'trae-agent': 'Trae Agent',
  aider: 'Aider',
  continue: 'Continue'
}

export function getAdapterName(adapterId: string): string {
  return adapterNames[adapterId] ?? adapterId
}
