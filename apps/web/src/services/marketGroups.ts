export type MarketGroup = {
  id: string
  name: string
}

type GroupAssignments = Record<string, string[]>

const GROUPS_KEY = 'tavern.market.groups.v1'
const ASSIGNMENTS_KEY = 'tavern.market.assignments.v1'

const makeGroupId = (): string =>
  'grp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)

const readGroups = (): MarketGroup[] => {
  try {
    const raw = localStorage.getItem(GROUPS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is MarketGroup =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as MarketGroup).id === 'string' &&
        typeof (entry as MarketGroup).name === 'string'
    )
  } catch {
    return []
  }
}

const writeGroups = (groups: MarketGroup[]): void => {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(groups))
  } catch {
    // 本地存储不可用时忽略。
  }
}

const readAssignments = (): GroupAssignments => {
  try {
    const raw = localStorage.getItem(ASSIGNMENTS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const result: GroupAssignments = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        result[key] = value.filter((id): id is string => typeof id === 'string')
      }
    }
    return result
  } catch {
    return {}
  }
}

const writeAssignments = (assignments: GroupAssignments): void => {
  try {
    localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(assignments))
  } catch {
    // 本地存储不可用时忽略。
  }
}

export function listMarketGroups(): MarketGroup[] {
  return readGroups()
}

export function getCardAssignments(): GroupAssignments {
  return readAssignments()
}

export function getCardGroupIds(cardKey: string): string[] {
  return readAssignments()[cardKey] ?? []
}

export function createMarketGroup(name: string): MarketGroup | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  const groups = readGroups()
  const existing = groups.find((group) => group.name === trimmed)
  if (existing) return existing
  const group = { id: makeGroupId(), name: trimmed.slice(0, 40) }
  writeGroups([...groups, group])
  return group
}

export function renameMarketGroup(groupId: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  const groups = readGroups().map((group) =>
    group.id === groupId ? { ...group, name: trimmed.slice(0, 40) } : group
  )
  writeGroups(groups)
}

export function deleteMarketGroup(groupId: string): void {
  writeGroups(readGroups().filter((group) => group.id !== groupId))
  const assignments = readAssignments()
  for (const key of Object.keys(assignments)) {
    assignments[key] = (assignments[key] ?? []).filter((id) => id !== groupId)
  }
  writeAssignments(assignments)
}

export function toggleCardGroup(cardKey: string, groupId: string): string[] {
  const assignments = readAssignments()
  const current = assignments[cardKey] ?? []
  const next = current.includes(groupId)
    ? current.filter((id) => id !== groupId)
    : [...current, groupId]
  if (next.length === 0) delete assignments[cardKey]
  else assignments[cardKey] = next
  writeAssignments(assignments)
  return next
}

export function setCardGroupIds(cardKey: string, groupIds: string[]): void {
  const assignments = readAssignments()
  if (groupIds.length === 0) delete assignments[cardKey]
  else assignments[cardKey] = groupIds
  writeAssignments(assignments)
}
