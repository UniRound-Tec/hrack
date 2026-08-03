import type { LaunchAugmentation } from '../types'

/** 只移除 Claude 官方用于阻止嵌套启动的已知 sentinel。 */
export function claudeEnvironmentAugmentation(): Pick<LaunchAugmentation, 'unsetEnv'> {
  return { unsetEnv: ['CLAUDECODE'] }
}
