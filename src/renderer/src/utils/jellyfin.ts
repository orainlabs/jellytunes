export const PAGE_SIZE = 50

export function jellyfinHeaders(apiKey: string): Record<string, string> {
  return {
    'X-MediaBrowser-Token': apiKey,
    'X-Emby-Token': apiKey,
    'Content-Type': 'application/json',
  }
}

export function buildUrl(base: string, path: string): string {
  const cleanBase = base.replace(/\/$/, '')
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `${cleanBase}${cleanPath}`
}
