export type SyseditQuestion = { id: string; target: string; question: string }

export type SyseditSummary = {
  stage: 'idle' | 'map' | 'edit' | 'grill' | 'implement' | 'verify' | 'done' | 'skipped'
  label: string
  id?: string
  title?: string
  status?: string
  openBlocking: SyseditQuestion[]
  questions: number
  suggested: number
  hasPlan: boolean
  driftOk?: boolean
  editorUrl?: string
}

declare module 'claude-code' {
  interface PluginState {
    sysedit: { summary: SyseditSummary; isBandHidden: boolean }
  }
}
