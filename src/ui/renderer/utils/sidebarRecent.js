import { BACKEND_ORIGIN } from './apiClient'

const KIND_LABEL = {
  project: 'Progetto',
  reel: 'Reel',
  trailer: 'Trailer',
}

const KIND_COLOR = {
  project: 'text-[#9090a8]',
  reel: 'text-[#c9a84c]',
  trailer: 'text-[#3b82f6]',
}

export function recentKindLabel(kind) {
  return KIND_LABEL[kind] || kind
}

export function recentKindColor(kind) {
  return KIND_COLOR[kind] || 'text-[#9090a8]'
}

export async function fetchRecentNavItems(limit = 3) {
  try {
    const res = await fetch(`${BACKEND_ORIGIN}/api/nav/recent?limit=${limit}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.items || []
  } catch {
    return []
  }
}
