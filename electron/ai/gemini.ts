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
    category: 'key_date' | 'family' | 'career_intel' | 'compensation' | 'obsession' | 'hot_button' | 'life_phase' | 'origin_story' | 'preference' | 'other'
    label: string | null
    value: string
    importance: 1 | 2 | 3
    needs_review: boolean
    event_type?: 'birthday' | 'anniversary' | 'travel' | 'return' | 'move' | 'important_date' | null
    subject?: string | null
    relation?: string | null
    date_value?: string | null
    date_precision?: 'exact' | 'month_day' | 'month' | 'year' | 'unknown' | null
  }>
  value_logs: Array<{
    type: 'introduction' | 'content' | 'referral' | 'opportunity'
    direction: 'given' | 'received'
    description: string
    introduced_person_name?: string | null
    introduced_person_company?: string | null
    introduced_to_name?: string | null
    introduced_to_company?: string | null
    connector_name?: string | null
    relationship_context?: string | null
    introduction_status?: 'requested' | 'offered' | 'made' | 'received' | null
    confidence?: 'low' | 'medium' | 'high' | null
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
  const allowed = new Set<WhatsappInsightExtraction['value_logs'][number]['type']>(['introduction', 'content', 'referral', 'opportunity'])
  const allowedStatus = new Set(['requested', 'offered', 'made', 'received'])
  const allowedConfidence = new Set(['low', 'medium', 'high'])
  const clean = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed || null
  }
  return valueLogs
    .filter((value) => value.description?.trim())
    .map((value) => {
      const type: WhatsappInsightExtraction['value_logs'][number]['type'] = allowed.has(value.type) ? value.type : 'content'
      const direction: WhatsappInsightExtraction['value_logs'][number]['direction'] = value.direction === 'received' ? 'received' : 'given'
      const introductionStatus = typeof value.introduction_status === 'string' && allowedStatus.has(value.introduction_status)
        ? value.introduction_status
        : null
      const confidence = typeof value.confidence === 'string' && allowedConfidence.has(value.confidence)
        ? value.confidence
        : null
      return {
        type,
        direction,
        description: value.description.trim(),
        introduced_person_name: clean(value.introduced_person_name),
        introduced_person_company: clean(value.introduced_person_company),
        introduced_to_name: clean(value.introduced_to_name),
        introduced_to_company: clean(value.introduced_to_company),
        connector_name: clean(value.connector_name),
        relationship_context: clean(value.relationship_context),
        introduction_status: introductionStatus,
        confidence,
      }
    })
    .filter((value) => {
      const text = value.description.toLowerCase()
      if (/\b(posiblemente|quizás|quizas|tal vez|parece|podría|podria)\b/i.test(text)) return false
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

function normalizeContactFacts(facts: WhatsappInsightExtraction['contact_facts']): WhatsappInsightExtraction['contact_facts'] {
  const allowed = new Set<WhatsappInsightExtraction['contact_facts'][number]['category']>([
    'key_date',
    'family',
    'career_intel',
    'compensation',
    'obsession',
    'hot_button',
    'life_phase',
    'origin_story',
    'preference',
    'other',
  ])
  return facts
    .filter((fact) => fact.value?.trim())
    .map((fact) => {
      const category: WhatsappInsightExtraction['contact_facts'][number]['category'] = allowed.has(fact.category) ? fact.category : 'other'
      const importance: WhatsappInsightExtraction['contact_facts'][number]['importance'] =
        fact.importance === 3 ? 3 : fact.importance === 1 ? 1 : 2
      return {
        category,
        label: fact.label,
        value: fact.value.trim(),
        importance,
        needs_review: Boolean(fact.needs_review),
        event_type: fact.event_type ?? null,
        subject: fact.subject ?? null,
        relation: fact.relation ?? null,
        date_value: fact.date_value ?? null,
        date_precision: fact.date_precision ?? null,
      }
    })
    .map((fact) => {
      const text = `${fact.label ?? ''} ${fact.value}`.toLowerCase()
      if (/\b(cumpleaños|birthday|aniversario|anniversary|fecha importante|nació|nacimiento|vuelve|regresa|sale de viaje|vacaciones|viaje|mudanza|se muda|se mudó|se mudo)\b/i.test(text)) {
        const eventType =
          /\b(cumpleaños|birthday|nació|nacimiento)\b/i.test(text) ? 'birthday' :
          /\b(aniversario|anniversary)\b/i.test(text) ? 'anniversary' :
          /\b(vuelve|regresa)\b/i.test(text) ? 'return' :
          /\b(viaje|vacaciones|sale de viaje)\b/i.test(text) ? 'travel' :
          /\b(mudanza|se muda|se mudó|se mudo)\b/i.test(text) ? 'move' :
          'important_date'
        return {
          ...fact,
          category: 'key_date' as const,
          label: fact.label ?? 'key_date',
          event_type: fact.event_type ?? eventType,
          date_precision: fact.date_precision ?? (fact.date_value ? 'exact' : 'unknown'),
        }
      }
      return fact
    })
    .filter((fact) => {
      const text = `${fact.label ?? ''} ${fact.value}`.toLowerCase()
      if (/\b(dolor|duele|síntoma|sintoma|enfermo|enferma|resfrío|resfrio|uña|golpe|me pegué|me pegue|cansad|sueño|hambre|lloró|lloro)\b/i.test(text)) return false
      if (/\b(hoy|ayer|mañana|manana|recién|recien|ahora|rato|almuerzo|cena|desayuno|uber|pedido|supermercado|llegando|salgo|llego)\b/i.test(text) && !/\b(viaje|vacaciones|vuelve|regresa|cumpleaños|birthday|aniversario|entrevista|trabajo|rol)\b/i.test(text)) return false
      if (fact.category === 'key_date') return true
      if (/\b(hijo|hija|niño|niña|bebé|bebe|espos|pareja|mamá|mama|papá|papa|herman|familia)\b/i.test(text) && /\b(se llama|llamad|nombre|nació|vive|cumpleaños|birthday)\b/i.test(text)) return true
      if (/\b(vive|reside|se mud|mudanza|ubicad|ciudad|país|pais|boston|chile|usa|estados unidos)\b/i.test(text)) return true
      if (/\b(trabaja|rol|cargo|empresa|compañía|compania|reclut|consultor|founder|manager|director|busca trabajo|empleo)\b/i.test(text)) return true
      if (/\b(le gusta|ama|apasiona|fan de|prefiere|odia|no le gusta|obsesion)\b/i.test(text)) return true
      if (fact.category === 'compensation' || fact.category === 'origin_story') return true
      return false
    })
}

function normalizeTodos(todos: WhatsappInsightExtraction['todos']): WhatsappInsightExtraction['todos'] {
  return todos
    .filter((todo) => todo.text?.trim())
    .map((todo) => ({
      text: todo.text.trim(),
      date: todo.date?.trim() || null,
    }))
    .filter((todo) => {
      const text = todo.text.toLowerCase()
      if (/\b(fajita|quesadilla|pollo|chocolate|costco|supermercado|carro|botella|agua|té|te |fórmula|formula|dormir|sueño|sueno|bebé|bebe|pañal|cocina|cocinar|almuerzo|cena|desayuno|avisar cuando salga|llegue|llegar)\b/i.test(text)) return false
      return /\b(reun|meeting|llamar|call|email|correo|mandar|enviar|compartir|present|introdu|conect|follow|seguimiento|cv|curriculum|resume|entrevista|trabajo|rol|postul|proyecto|cliente|lead|oportunidad|documento|archivo|link|agenda|coordinar|confirmar)\b/i.test(text)
    })
}

export async function extractWhatsappInsights(input: {
  conversationText: string
  interactionDate: string
  contactName?: string | null
  feedbackGuidance?: string | null
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
    'contact_facts también es estricto: solo memoria durable y útil para relación/CRM.',
    'Separa key dates de facts:',
    '- key_date: cumpleaños, aniversarios, fecha de viaje/vuelta, mudanza, eventos importantes fechables.',
    '- key_date SIEMPRE debe incluir qué es + quién/persona relacionada + fecha. Ejemplos: "Cumpleaños de Domingo (hijo): 2023-05-12", "Vuelve de vacaciones: 2026-07-03", "Aniversario de matrimonio: fecha no especificada".',
    '- NO pongas una fecha sola. Si sabes el evento/persona pero no la fecha exacta, escribe "fecha no especificada" para que el usuario pueda completarla.',
    '- Para key_date llena además: event_type, subject, relation, date_value y date_precision. subject es la persona/cosa de la fecha; relation es hijo, pareja, contacto, etc. date_value debe ser YYYY-MM-DD si es exacta; si solo hay mes/día usa MM-DD y date_precision="month_day"; si no hay fecha usa null y date_precision="unknown".',
    '- facts: gustos, preferencias, pasiones, contexto durable, ubicación, familia, trabajo/carrera, compensación o información sensible estable.',
    'Incluye contact_facts solo si son de estas clases:',
    '- familia estable: nombres de hijos/pareja/padres/hermanos, relaciones importantes.',
    '- ubicación estable: dónde vive, ciudad/país, mudanza.',
    '- trabajo/carrera: rol, empresa, búsqueda laboral, proyecto profesional relevante.',
    '- gustos/pasiones/preferencias fuertes: hobbies, cosas que ama/odia/prefiere repetidamente.',
    '- compensación o información sensible estable, con needs_review=true si corresponde.',
    'Evita facts genéricos repetidos. Si ya queda claro que tiene hijo/pareja/vive en X, no repitas variantes salvo que aparezca un nombre, fecha o dato nuevo.',
    'NO es fact: dolor/síntoma del día, logística cotidiana, comida puntual, ánimo pasajero, una queja momentánea, accidente menor, coordinación familiar normal, conversación casual.',
    'value_logs es MUY estricto. Solo incluye valor si hay una de estas señales explícitas:',
    '- introduction: se presentó o conectó a una persona concreta.',
    '- content: se compartió un archivo, link, documento, CV, plantilla, recurso o media relevante.',
    '- referral: se derivó/recomendó una persona para una oportunidad concreta.',
    '- opportunity: se compartió una oportunidad, lead, trabajo, cliente o deal concreto.',
    '- content también puede usarse para info relevante NO pública y accionable, pero la descripción debe empezar con "Info no pública:".',
    'Para introduction/referral, captura relaciones estructuradas cuando el texto lo permita:',
    '- connector_name: quien está haciendo o facilitando la conexión. Si soy yo, usa "me".',
    '- introduced_person_name/company: persona u organización presentada/recomendada.',
    '- introduced_to_name/company: destinatario de la intro o quien recibe la recomendación.',
    '- relationship_context: por qué la conexión importa, en pocas palabras.',
    '- introduction_status: requested si alguien pidió la intro, offered si se ofreció, made si la intro ya ocurrió, received si me presentaron a mí.',
    '- confidence: high solo si los nombres/roles son claros; medium si falta empresa/contexto; low si requiere revisión.',
    'NO es value: apoyo emocional, ánimo, opinión, coordinación familiar, logística, bromas, consejos genéricos, cariño, pagos cotidianos, disponibilidad o conversación normal.',
    'todos también es estricto: solo compromisos/follow-ups relevantes para CRM, carrera, proyecto, intro, documento, reunión, oportunidad o relación profesional/personal significativa.',
    'NO es todo: comida, supermercado, traer cosas, sueño del bebé, fórmula, salud cotidiana, logística doméstica, avisar al salir/llegar o coordinación normal del día.',
    'Si hay compromiso o siguiente paso concreto y relevante, va en todos y, si corresponde, también next_step.',
    input.feedbackGuidance
      ? `Feedback reciente del usuario. Úsalo como reglas de calibración para esta extracción:\n${input.feedbackGuidance}`
      : '',
    `Fecha exacta de interacción: ${input.interactionDate}. Usa esa fecha para todos/tareas si no hay otra fecha explícita.`,
    input.contactName ? `Contacto: ${input.contactName}` : '',
    '',
    'Schema exacto:',
    '{',
    '  "summary": "1-2 frases en español sobre tema, outcome y tono",',
    '  "next_step": "acción concreta o null",',
    '  "next_step_date": "YYYY-MM-DD o null",',
    '  "next_step_owner": "me | them | null",',
    '  "contact_facts": [{"category":"key_date|family|career_intel|compensation|obsession|hot_button|life_phase|origin_story|preference|other","label":null|string,"value":"hecho durable, estable y útil","importance":1|2|3,"needs_review":true|false,"event_type":"birthday|anniversary|travel|return|move|important_date|null","subject":null|string,"relation":null|string,"date_value":null|string,"date_precision":"exact|month_day|month|year|unknown|null"}],',
    '  "value_logs": [{"type":"introduction|content|referral|opportunity","direction":"given|received","description":"valor explícito, no conversación normal","introduced_person_name":null|string,"introduced_person_company":null|string,"introduced_to_name":null|string,"introduced_to_company":null|string,"connector_name":null|string,"relationship_context":null|string,"introduction_status":"requested|offered|made|received|null","confidence":"low|medium|high|null"}],',
    '  "todos": [{"text":"tarea concreta","date":"YYYY-MM-DD|null"}]',
    '}',
    '',
    '--- CONVERSACIÓN ---',
    truncated,
    '--- FIN ---',
  ].filter(Boolean).join('\n')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 25_000)

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
      contact_facts: Array.isArray(parsed.contact_facts) ? normalizeContactFacts(parsed.contact_facts) : [],
      value_logs: Array.isArray(parsed.value_logs) ? normalizeValueLogs(parsed.value_logs) : [],
      todos: Array.isArray(parsed.todos) ? normalizeTodos(parsed.todos) : [],
    }
  } catch (err) {
    console.error('[gemini] extraction failed:', err)
    return fallbackExtraction(input.conversationText)
  } finally {
    clearTimeout(timeout)
  }
}
