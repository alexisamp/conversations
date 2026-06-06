// GeminiSummarizer — produces a 2-line summary of a WhatsApp conversation
// session using Gemini 2.0 Flash via direct REST.
//
// Same approach as reThink's useGeminiScorer.ts: no SDK, just fetch to
// generativelanguage.googleapis.com/v1beta.

const DEFAULT_MODEL = 'gemini-2.5-flash'

function getApiKey(): string | null {
  return process.env.VITE_GEMINI_API_KEY ?? null
}

function getModel(): string {
  return process.env.VITE_GEMINI_MODEL || DEFAULT_MODEL
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
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${getModel()}:generateContent?key=${apiKey}`

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

export type WhatsappInsightExtraction = {
  summary: string
  next_step: string | null
  next_step_date: string | null
  next_step_owner: 'me' | 'them' | null
  contact_facts: Array<{
    category: 'family' | 'career_intel' | 'compensation' | 'obsession' | 'hot_button' | 'life_phase' | 'pet_peeve' | 'origin_story' | 'health' | 'preference' | 'other'
    label: string | null
    value: string
    importance: 1 | 2 | 3
    needs_review: boolean
  }>
  value_logs: Array<{
    type: 'introduction' | 'content' | 'referral' | 'opportunity'
    direction: 'given' | 'received'
    description: string
  }>
  todos: Array<{
    text: string
    date: string | null
  }>
}

function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) return raw.slice(start, end + 1)
  return null
}

function fallbackExtraction(conversationText: string): WhatsappInsightExtraction {
  const compact = conversationText
    .split('\n')
    .filter(Boolean)
    .slice(-8)
    .join(' ')
    .slice(0, 600)
  return {
    summary: compact || 'Conversación de WhatsApp capturada sin texto legible.',
    next_step: null,
    next_step_date: null,
    next_step_owner: null,
    contact_facts: [],
    value_logs: [],
    todos: [],
  }
}

function normalizeValueLogs(valueLogs: WhatsappInsightExtraction['value_logs']): WhatsappInsightExtraction['value_logs'] {
  const allowed = new Set(['introduction', 'content', 'referral', 'opportunity'])
  return valueLogs
    .filter((value) => value.description?.trim())
    .map((value) => ({
      type: allowed.has(value.type) ? value.type : 'content',
      direction: value.direction === 'received' ? 'received' : 'given',
      description: value.description.trim(),
    }))
    .filter((value) => {
      const text = value.description.toLowerCase()
      if (value.type === 'introduction') {
        return /\b(introdu|present|conect|conex|intro)\w*/i.test(text)
      }
      if (value.type === 'referral') {
        return /\b(referr|refer|recomen|deriv|candidat|postul)\w*/i.test(text)
      }
      if (value.type === 'opportunity') {
        return /\b(oportunidad|trabajo|cliente|deal|lead|vacante|entrevista|rol|position|job)\b/i.test(text)
      }
      return /\b(archivo|file|documento|doc|link|url|recurso|plantilla|cv|resume|pdf|sheet|info no pública|información no pública|dato no público)\b/i.test(text)
    })
}

export async function extractWhatsappInsights(input: {
  conversationText: string
  interactionDate: string
  contactName?: string | null
}): Promise<WhatsappInsightExtraction> {
  const apiKey = getApiKey()
  if (!input.conversationText.trim()) return fallbackExtraction(input.conversationText)
  if (!apiKey) {
    console.warn('[gemini] no VITE_GEMINI_API_KEY — using deterministic extraction fallback')
    return fallbackExtraction(input.conversationText)
  }

  const truncated =
    input.conversationText.length > 16000
      ? input.conversationText.slice(-16000) + '\n[...truncated earlier messages]'
      : input.conversationText

  const prompt = [
    'Analiza esta conversación 1:1 de WhatsApp para reThink CRM.',
    'Devuelve SOLO JSON válido, sin markdown.',
    'No inventes hechos. Si algo no es claro, omítelo o márcalo needs_review.',
    'No copies mensajes crudos largos. Escribe resúmenes breves y accionables.',
    'La conversación ya viene cortada por día local y por ventana corta; NO consolides varios días.',
    'El campo summary solo va a interactions.notes. No escondas facts, valor o tareas dentro del summary.',
    'Si aparece un hecho durable sobre la persona, va en contact_facts. Si es sensible o ambiguo, usa needs_review=true.',
    'value_logs es MUY estricto. Solo incluye valor si hay una de estas señales explícitas:',
    '- introduction: se presentó o conectó a una persona concreta.',
    '- content: se compartió un archivo, link, documento, CV, plantilla, recurso o media relevante.',
    '- referral: se derivó/recomendó una persona para una oportunidad concreta.',
    '- opportunity: se compartió una oportunidad, lead, trabajo, cliente o deal concreto.',
    '- content también puede usarse para info relevante NO pública y accionable, pero la descripción debe empezar con "Info no pública:".',
    'NO es value: apoyo emocional, ánimo, opinión, coordinación familiar, logística, bromas, consejos genéricos, cariño, pagos cotidianos, disponibilidad o conversación normal.',
    'Si hay compromiso o siguiente paso concreto, va en todos y, si corresponde, también next_step.',
    `Fecha exacta de interacción: ${input.interactionDate}. Usa esa fecha para todos/tareas si no hay otra fecha explícita.`,
    input.contactName ? `Contacto: ${input.contactName}` : '',
    '',
    'Schema exacto:',
    '{',
    '  "summary": "1-2 frases en español sobre tema, outcome y tono",',
    '  "next_step": "acción concreta o null",',
    '  "next_step_date": "YYYY-MM-DD o null",',
    '  "next_step_owner": "me | them | null",',
    '  "contact_facts": [{"category":"family|career_intel|compensation|obsession|hot_button|life_phase|pet_peeve|origin_story|health|preference|other","label":null|string,"value":"hecho durable","importance":1|2|3,"needs_review":true|false}],',
    '  "value_logs": [{"type":"introduction|content|referral|opportunity","direction":"given|received","description":"valor explícito, no conversación normal"}],',
    '  "todos": [{"text":"tarea concreta","date":"YYYY-MM-DD|null"}]',
    '}',
    '',
    '--- CONVERSACIÓN ---',
    truncated,
    '--- FIN ---',
  ].filter(Boolean).join('\n')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 45_000)

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${getModel()}:generateContent?key=${apiKey}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      console.error('[gemini] extraction API error:', res.status, errBody.slice(0, 200))
      return fallbackExtraction(input.conversationText)
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    const json = extractJsonObject(raw)
    if (!json) return fallbackExtraction(input.conversationText)
    const parsed = JSON.parse(json) as Partial<WhatsappInsightExtraction>
    return {
      summary: typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : fallbackExtraction(input.conversationText).summary,
      next_step: typeof parsed.next_step === 'string' && parsed.next_step.trim() ? parsed.next_step.trim() : null,
      next_step_date: typeof parsed.next_step_date === 'string' && parsed.next_step_date.trim() ? parsed.next_step_date.trim() : null,
      next_step_owner: parsed.next_step_owner === 'me' || parsed.next_step_owner === 'them' ? parsed.next_step_owner : null,
      contact_facts: Array.isArray(parsed.contact_facts) ? parsed.contact_facts : [],
      value_logs: Array.isArray(parsed.value_logs) ? normalizeValueLogs(parsed.value_logs) : [],
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
    }
  } catch (err) {
    console.error('[gemini] extraction failed:', err)
    return fallbackExtraction(input.conversationText)
  } finally {
    clearTimeout(timeout)
  }
}
