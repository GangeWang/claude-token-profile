export type View = 'daily' | 'weekly' | 'cumulative'

export type Ranked = { name: string; tokens: number }

/** What scripts/collect.py prints. */
export type Report = {
  name: string
  /** The signed-in account's picture, base64 WebP. */
  avatar: string | null
  today: string
  firstDay: string | null
  lifetime: number
  parts: {
    input: number
    output: number
    cacheWrite: number
    cacheRead: number
  }
  peak: { day: string | null; tokens: number }
  longestTask: { ms: number; project: string | null }
  longestStreak: number
  currentStreak: number
  days: Record<string, number>
  models: Ranked[]
  projects: Ranked[]
  /** Tokens per computer; one row until a second computer syncs. */
  machines: Ranked[]
  syncError: string | null
  /** Where the files every conversation shares live. */
  dataDir: string
}

/** What every conversation on this computer shows, in ui.json. */
export type SharedScreen = { view: View; isOpen: boolean }

declare module 'claude-code' {
  interface PluginState {
    'token-profile': {
      report: Shaped<Report | null>
      view: Shaped<View>
      error: Shaped<string | null>
      isOpen: Shaped<boolean>
    }
  }
}
