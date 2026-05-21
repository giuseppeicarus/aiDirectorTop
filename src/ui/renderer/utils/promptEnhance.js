/** Separatore blocco negazione (allineato a prompt_enhance.py). */
export const NEGATIVE_BLOCK_MARKER = '--- Negative prompt ---'

/**
 * Separa prompt positivo e negative dal textarea (dopo "Migliora prompt").
 */
export function splitPositiveAndNegative(combined, fallbackNegative = '') {
  const text = String(combined || '').trim()
  if (!text) return { positive: '', negative: String(fallbackNegative || '').trim() }

  if (text.includes(NEGATIVE_BLOCK_MARKER)) {
    const [base, negPart] = text.split(NEGATIVE_BLOCK_MARKER)
    return {
      positive: base.trim(),
      negative: (negPart || '').trim() || String(fallbackNegative || '').trim(),
    }
  }
  return { positive: text, negative: String(fallbackNegative || '').trim() }
}

/**
 * Normalizza la risposta "Migliora prompt" — solo testo, mai JSON grezzo nel textarea.
 */
export function normalizeEnhancedText(value, fallback = '') {
  if (value == null || value === '') return fallback

  if (typeof value === 'object') {
    const t =
      value.prompt || value.enhanced || value.text || value.improved_prompt
    return typeof t === 'string' && t.trim() ? t.trim() : fallback
  }

  const s = String(value).trim()
  if (!s) return fallback

  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s)
      if (parsed && typeof parsed === 'object') {
        const inner =
          parsed.prompt || parsed.enhanced || parsed.text || parsed.improved_prompt
        if (typeof inner === 'string' && inner.trim()) return inner.trim()
      }
    } catch {
      /* testo libero */
    }
  }

  return s
}

export function normalizeNegativeText(value) {
  if (value == null || value === '') return null
  if (typeof value === 'object') {
    const t = value.negative_prompt || value.negative
    return typeof t === 'string' && t.trim() ? t.trim() : null
  }
  const s = String(value).trim()
  if (!s) return null
  if (s.startsWith('{')) {
    try {
      const parsed = JSON.parse(s)
      const inner = parsed.negative_prompt || parsed.negative
      if (typeof inner === 'string' && inner.trim()) return inner.trim()
    } catch {
      return null
    }
  }
  return s
}

/** Testo textarea: positivo + blocco negazione in coda. */
export function buildCombinedPrompt(enhanced, negative) {
  const pos = normalizeEnhancedText(enhanced, '')
  const neg = normalizeNegativeText(negative)
  if (!pos) return ''
  if (!neg) return pos
  if (pos.includes(NEGATIVE_BLOCK_MARKER)) return pos
  return `${pos}\n\n${NEGATIVE_BLOCK_MARKER}\n${neg}`
}

/** Prompt unico da risposta Migliora (positivo + blocco negative nello stesso testo). */
export function normalizeUnifiedPrompt(enhanced, combinedFallback = '', extraNegative = null) {
  let u = normalizeEnhancedText(enhanced, '')
  if (!u) u = String(combinedFallback || '').trim()
  if (!u) return ''
  if (u.includes(NEGATIVE_BLOCK_MARKER)) return u
  const neg = normalizeNegativeText(extraNegative)
  if (neg) return buildCombinedPrompt(u, neg)
  return u
}
