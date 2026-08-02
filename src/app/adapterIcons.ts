import ClaudeCode from '@lobehub/icons/es/ClaudeCode/components/Mono'
import Codex from '@lobehub/icons/es/Codex/components/Mono'
import Cursor from '@lobehub/icons/es/Cursor/components/Mono'
import GeminiCLI from '@lobehub/icons/es/GeminiCLI/components/Mono'
import LobeHub from '@lobehub/icons/es/LobeHub/components/Mono'
import OpenCode from '@lobehub/icons/es/OpenCode/components/Mono'
import type { ComponentType, SVGProps } from 'react'

export type BrandIcon = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string }
>

const adapterIcons: Record<string, BrandIcon> = {
  codex: Codex,
  'claude-code': ClaudeCode,
  'cursor-agent': Cursor,
  gemini: GeminiCLI,
  opencode: OpenCode,
  aider: LobeHub,
  'warp-agent': LobeHub,
  continue: LobeHub
}

export function getAdapterIcon(adapterId: string): BrandIcon {
  return adapterIcons[adapterId] ?? LobeHub
}
