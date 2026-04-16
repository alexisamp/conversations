// GeminiSummarizer — produces a 2-line summary of a WhatsApp conversation
// session using Gemini 2.0 Flash via direct REST.
//
// Same approach as reThink's useGeminiScorer.ts: no SDK, just fetch to
// generativelanguage.googleapis.com/v1beta.

const MODEL = 'gemini-2.0-flash'

function getApiKey(): string | null {
  return process.env.VITE_GEMINI_API_KEY ?? null
}

/**
 * Summarize a conversation session in exactly 2 lines of Spanish.
 * Line 1: topic / context of what was discussed.
 * Line 2: outcome / commitment / sentiment.
 *
 * Returns null if the API key is missing or the call fails.
 */
export async function summarizeSession(
  conversationText: string,
): Promise<string | null> {
  const apiKey = getApiKey()
  if (!apiKey) {
    console.warn('[gemini] no VITE_GEMINI_API_KEY — skipping summary')
    return null
  }

  if (!conversationText.trim()) return null

  // Truncate very long conversations to avoid token limits.
  // 10k chars ≈ 2.5k tokens, well within Flash's 1M context.
  const truncated =
    conversationText.length > 10000
      ? conversationText.slice(-10000) + '\n[...truncated earlier messages]'
      : conversationText

  const prompt = [
    'Resume la siguiente conversación de WhatsApp en exactamente 2 líneas en español.',
    'Línea 1: tema o contexto de la conversación.',
    'Línea 2: resultado, compromiso o sentimiento.',
    'Solo las 2 líneas, sin viñetas ni formato adicional.',
    '',
    '--- CONVERSACIÓN ---',
    truncated,
    '--- FIN ---',
  ].join('\n')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      console.error('[gemini] API error:', res.status, errBody.slice(0, 200))
      return null
    }

    const data = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> }
      }>
    }
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    const summary = raw.trim()

    if (!summary) {
      console.warn('[gemini] empty summary response')
      return null
    }

    return summary
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.error('[gemini] request timed out after 30s')
    } else {
      console.error('[gemini] summarize failed:', err)
    }
    return null
  } finally {
    clearTimeout(timeout)
  }
}
