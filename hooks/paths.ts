export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project'

export const projectOf = (cwd: string): string => slug(cwd.split('/').filter(Boolean).pop() ?? '')

// Claude Code keeps a session's transcript at ~/.claude/projects/<cwd with non-alphanumerics as dashes>/<id>.jsonl.
export const transcriptOf = (cwd: string, id: string): string =>
  `~/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`

export const fileName = (date: string, id: string): string => `${date}_${id.slice(0, 8)}.md`

export const metricsOf = (file: string): string => file.replace(/\.md$/, '.metrics.jsonl')

export const dirOf = (file: string): string => file.slice(0, file.lastIndexOf('/'))

export const baseOf = (file: string): string => file.slice(file.lastIndexOf('/') + 1)

export const pendingOf = (file: string): string => file.replace(/\.md$/, '.pending.json')
