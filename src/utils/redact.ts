/**
 * Helpers to keep secrets (session cookies, RTSP credentials) out of the logs.
 */

/**
 * Replaces embedded credentials in URLs (e.g. rtsp://user:pass@host) with placeholders.
 */
export function redactUrlCredentials(text: string): string {
  return text.replace(/([a-z]+:\/\/)[^/\s:@]+:[^/\s@]*@/gi, '$1****:****@');
}

/**
 * Produces a short, non-reversible descriptor of a token for debug logging.
 */
export function describeToken(token: string | undefined): string {
  if (!token) {
    return '(none)';
  }
  return `(token, ${token.length} chars)`;
}
