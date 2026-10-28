// 宿主 SDK 的替身，只为在本机跑类型检查与单测。
// 真包 `@deepseek-ai/dsh-tools` 不在磁盘上——由 DSH 宿主在加载插件时注入
// （已实证：装在 profile 里的第三方插件 ds-bot 也是这么 `import { defineTool } from '@deepseek-ai/dsh-tools'`）。
// 这里按 ds-bot 的实际用法反推最小形状，不是权威定义。
export type Parameter = {
  type: 'string' | 'number' | 'boolean'
  required?: boolean
  description?: string
  enum?: readonly string[]
}

export type ToolOutput = {
  schema: unknown
  render: (args: unknown, value: unknown) => unknown
}

export type ToolSpec<Args> = {
  name: string
  description: string
  parameters: Record<string, Parameter>
  output?: ToolOutput
  execute: (args: Args, exec: unknown) => unknown
}

export function defineTool<Args>(spec: ToolSpec<Args>): ToolSpec<Args> {
  return spec
}
