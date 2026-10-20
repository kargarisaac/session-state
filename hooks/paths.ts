export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project'

export const projectOf = (cwd: string): string => slug(cwd.split('/').filter(Boolean).pop() ?? '')

// Claude Code keeps a session's transcript at ~/.claude/projects/<cwd with non-alphanumerics as dashes>/<id>.jsonl.
export const transcriptOf = (cwd: string, id: string): string =>
  `~/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`

// One folder per session: <project>/<date>_<id8>/.
export const folderName = (date: string, id: string): string => `${date}_${id.slice(0, 8)}`

export const stateOf = (dir: string): string => `${dir}/state.md`
export const stepsOf = (dir: string): string => `${dir}/steps.md`
export const historyOf = (dir: string): string => `${dir}/history.md`
export const eventsOf = (dir: string): string => `${dir}/events.jsonl`
export const pendingOf = (dir: string): string => `${dir}/pending.json`

export const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

export const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
