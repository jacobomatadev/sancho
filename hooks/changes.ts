import type { FileEdit } from '../types'

type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: readonly string[] }

/** The largest diff kept per edit; whole hunks only, so it still parses. */
const MAX_PATCH = 20_000

const isHunk = (value: unknown): value is Hunk =>
  typeof value === 'object' &&
  value !== null &&
  'lines' in value &&
  Array.isArray(value.lines) &&
  'oldStart' in value &&
  typeof value.oldStart === 'number'

/** A path inside the project, shown from the project; anything else whole. */
export function shortPath(path: string, root: string): string {
  const base = root.endsWith('/') ? root : `${root}/`
  return root !== '' && path.startsWith(base) ? path.slice(base.length) : path
}

/**
 * An edit from what Edit, MultiEdit or Write returned: their `structuredPatch`.
 * Null when the result carries none (an error, a tool of another shape).
 */
export function editFrom(
  result: unknown,
  meta: { id: string; root: string; at: number; agentId: string | null },
): FileEdit | null {
  if (typeof result !== 'object' || result === null) return null
  const record = result as Record<string, unknown>
  const path = record.filePath
  const hunks = record.structuredPatch
  if (typeof path !== 'string' || !Array.isArray(hunks)) return null

  let patch = ''
  let additions = 0
  let deletions = 0
  for (const hunk of hunks.filter(isHunk)) {
    const text = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}`
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions += 1
      else if (line.startsWith('-')) deletions += 1
    }
    if (patch.length + text.length <= MAX_PATCH) patch = patch === '' ? text : `${patch}\n${text}`
  }
  const isNew = record.type === 'create' || (record.originalFile === null && 'content' in record)
  if (patch === '' && isNew && typeof record.content === 'string') {
    const lines = record.content.split('\n')
    additions = lines.length
    const created = `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}`
    if (created.length <= MAX_PATCH) patch = created
  }

  return {
    id: meta.id,
    path: shortPath(path, meta.root),
    isNew,
    patch,
    additions,
    deletions,
    at: meta.at,
    agentId: meta.agentId,
  }
}

export type FileSummary = { path: string; isNew: boolean; additions: number; deletions: number; firstIndex: number }

/** This turn's edits by file, in the order the files were first touched. */
export function filesOf(edits: readonly FileEdit[]): FileSummary[] {
  const files: FileSummary[] = []
  edits.forEach((edit, index) => {
    const file = files.find(one => one.path === edit.path)
    if (file === undefined) {
      files.push({ path: edit.path, isNew: edit.isNew, additions: edit.additions, deletions: edit.deletions, firstIndex: index })
    } else {
      file.additions += edit.additions
      file.deletions += edit.deletions
    }
  })
  return files
}
