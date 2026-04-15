import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import path from 'path'

interface Preferences {
  analyticsEnabled: boolean
}

const DEFAULT_PREFS: Preferences = { analyticsEnabled: true }

function getPrefsPath(): string {
  return path.join(app.getPath('userData'), 'preferences.json')
}

export function getPreferences(): Preferences {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(readFileSync(getPrefsPath(), 'utf8')) }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function setPreferences(partial: Partial<Preferences>): void {
  const current = getPreferences()
  writeFileSync(getPrefsPath(), JSON.stringify({ ...current, ...partial }, null, 2))
}
