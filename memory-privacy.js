// Privacy filtering applies to derived knowledge, never to original session backups.
// This is conservative pattern filtering, not a guarantee that every secret is detected.
function privateText(value, initialDepth = 0) {
  const text = String(value), tag = /<\s*(\/?)\s*private\b[^>]*>/gi;
  let depth = initialDepth, offset = 0, output = '', match;
  while ((match = tag.exec(text))) {
    if (!depth) output += text.slice(offset, match.index);
    if (match[1]) depth = Math.max(0, depth - 1);
    else if (!/\/\s*>$/.test(match[0])) depth++;
    offset = tag.lastIndex;
  }
  if (!depth) output += text.slice(offset);
  // An incomplete opening tag is private too: a truncated message must not leak its tail.
  if (!depth) {
    const incomplete = output.search(/<\s*private\b[^>]*$/i);
    if (incomplete >= 0) { output = output.slice(0, incomplete); depth = 1; }
  }
  return { text: output, depth };
}

function redactSecrets(text) {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/=\-]{8,}/gi, '$1[REDACTED]')
    .replace(/\b(Basic\s+)[A-Za-z0-9+/=]{8,}/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-(?:proj-|ant-api\d{2}-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{30,})\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/(\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*)(\[[^\]\r\n]*\]|"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi,
      (_match, key, value) => /^(?:\[REDACTED\]|"\[REDACTED\]"|'\[REDACTED\]')$/.test(value) ? key + value : key + '[REDACTED]')
    .replace(/\b(https?:\/\/)[^\s\/@:]+:[^\s\/@]+@/gi, '$1[REDACTED]@')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}

function redactText(text) {
  if (typeof text !== 'string') throw new Error('Memory text must be a string');
  return redactSecrets(privateText(text).text).trim();
}

module.exports = { redactText, privateText, redactSecrets };
