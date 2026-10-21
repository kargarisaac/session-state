// Every pattern starts on a literal or a line start, or is bounded, so a huge paste cannot make one scan quadratic.
const PATTERNS: [RegExp, string][] = [
  // A key block, or the start of one when the text was cut before its end line.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted key]'],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, '[redacted key]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[redacted token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted token]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[redacted token]'],
  [/\b(?:hf|npm)_[A-Za-z0-9]{30,}/g, '[redacted token]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted key]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted token]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[redacted key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted token]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [redacted]'],
  [/\b(Authorization:\s*Basic)\s+[A-Za-z0-9+/]{8,}={0,2}/gi, '$1 [redacted]'],
  // user:password@ inside a URL.
  [/\b([a-z][a-z0-9+.-]{1,15}:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@'],
  // NAME=value lines whose name says it is a secret.
  [/^([ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*[ \t]*=[ \t]*).+$/gm, '$1[redacted]'],
  // The same inside a command line: FOO_TOKEN=abc python run.py
  [/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*=)\S+/g, '$1[redacted]'],
  // A secret-named setting with a long value that has a digit in it: aws_secret_access_key = ..., "password": "...".
  [
    /\b([A-Za-z0-9_.-]{0,30}(?:secret|passwd|password|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]{0,30}["']?[ \t]*[=:][ \t]*["']?)(?=[A-Za-z0-9/+_=.~-]*\d)[A-Za-z0-9/+_=.~-]{12,}/gi,
    '$1[redacted]',
  ],
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
