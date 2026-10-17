const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted key]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[redacted token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted key]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted token]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[redacted key]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [redacted]'],
  // NAME=value lines whose name says it is a secret.
  [/^(\s*(?:export\s+)?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\s*=\s*).+$/gm, '$1[redacted]'],
]

export const redact = (text: string): string => PATTERNS.reduce((out, [re, to]) => out.replace(re, to), text)

// Keeps the start and the end, which is where a message states its point and its latest ask.
export const clip = (text: string, max: number): string => {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = max - head
  return `${text.slice(0, head)}\n[... ${text.length - max} characters cut ...]\n${text.slice(text.length - tail)}`
}

export const tidy = (text: string, max: number): string => clip(redact(text), max)
