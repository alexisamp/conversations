// LinkedIn profile photo uploader.
//
// media.licdn.com URLs expire within days/weeks — once a LinkedIn photo row
// is written to outreach_logs.profile_photo_url using the raw CDN URL, the
// image breaks over time. Solution: mirror the photo into Supabase Storage
// (bucket `contact-photos`) and use the permanent public URL instead.
//
// Ported from the Chrome extension's uploadLinkedInPhoto (service-worker.ts)
// but runs in Electron main — no LI cookies. Most LinkedIn profile-photo
// CDN URLs are publicly accessible without cookies, so this works for the
// common case. If LinkedIn locks down the CDN in the future, we'd need a
// renderer-side capture that uses the LI webContents session cookies and
// pipes the bytes through IPC.
import { getSupabase } from './client'

function pickExt(contentType: string | null | undefined): string {
  const t = (contentType ?? '').toLowerCase()
  if (t.includes('png')) return 'png'
  if (t.includes('webp')) return 'webp'
  return 'jpg'
}

function slugFromLinkedinUrl(linkedinUrl: string): string {
  return linkedinUrl.match(/\/in\/([^/?#]+)/)?.[1] ?? 'photo'
}

/**
 * Download the LinkedIn photo at `photoUrl` and upload it to Supabase Storage.
 * Returns the permanent public URL on success, or null on any failure
 * (caller should fall back to the original URL).
 *
 * Idempotent: overwrites the same object at `{userId}/{slug}.{ext}`.
 */
export async function uploadLinkedInPhoto(
  photoUrl: string,
  linkedinUrl: string,
): Promise<string | null> {
  try {
    const supabase = getSupabase()

    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session) {
      console.warn('[photo-upload] no session — cannot upload')
      return null
    }
    const userId = session.user.id
    const token = session.access_token

    // Fetch the image (Electron main has no cookie jar scoped to LI, but
    // LinkedIn's profile-photo CDN is public).
    const res = await fetch(photoUrl)
    if (!res.ok) {
      console.warn('[photo-upload] fetch failed:', res.status, res.statusText)
      return null
    }
    const contentType = res.headers.get('content-type')
    const blob = await res.blob()

    const slug = slugFromLinkedinUrl(linkedinUrl)
    const ext = pickExt(contentType ?? blob.type)
    const storagePath = `${userId}/${slug}.${ext}`

    // Use Supabase Storage REST directly (supabase-js storage client also works
    // but the REST path mirrors the extension's approach and avoids surprises
    // with content-type/upsert headers in Electron's Node fetch).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabaseUrl = (supabase as any).supabaseUrl as string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabaseAnon = (supabase as any).supabaseKey as string

    const uploadRes = await fetch(
      `${supabaseUrl}/storage/v1/object/contact-photos/${storagePath}`,
      {
        method: 'POST',
        headers: {
          apikey: supabaseAnon,
          Authorization: `Bearer ${token}`,
          'Content-Type': contentType ?? blob.type ?? 'image/jpeg',
          'x-upsert': 'true',
        },
        body: blob,
      },
    )

    if (!uploadRes.ok) {
      const txt = await uploadRes.text().catch(() => '')
      console.warn(
        '[photo-upload] upload failed:',
        uploadRes.status,
        uploadRes.statusText,
        txt.slice(0, 200),
      )
      return null
    }

    const permanentUrl = `${supabaseUrl}/storage/v1/object/public/contact-photos/${storagePath}`
    console.log('[photo-upload] uploaded →', permanentUrl)
    return permanentUrl
  } catch (err) {
    console.warn('[photo-upload] unexpected error:', err)
    return null
  }
}
