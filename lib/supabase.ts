import { createClient } from '@supabase/supabase-js'

// Placeholder used during SSR / static prerender so Next.js can build the HTML
// shell without needing real credentials. All actual data fetching happens
// client-side after hydration.
const SSR_URL = 'https://placeholder.supabase.co'
const SSR_KEY = 'placeholder'

// Singleton browser client — reused across all components to avoid the
// "Multiple GoTrueClient instances" warning and session conflicts.
let _browserClient: ReturnType<typeof createClient> | null = null

export function createBrowserClient() {
  // During SSR / static prerender there is no browser — return a safe no-op
  // client. Never cache this instance.
  if (typeof window === 'undefined') {
    return createClient(SSR_URL, SSR_KEY)
  }

  // Return existing singleton if already created
  if (_browserClient) return _browserClient

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !key) {
    console.error(
      '[Garvin] Missing Supabase env vars.\n' +
      'In Vercel → Project Settings → Environment Variables, add:\n' +
      '  NEXT_PUBLIC_SUPABASE_URL  = https://xxxx.supabase.co\n' +
      '  NEXT_PUBLIC_SUPABASE_ANON_KEY = eyJ...'
    )
    return createClient(SSR_URL, SSR_KEY)
  }

  // Guard against a URL that is set but malformed (e.g. missing https://)
  try {
    _browserClient = createClient(url, key)
    return _browserClient
  } catch (err) {
    console.error(
      '[Garvin] Invalid NEXT_PUBLIC_SUPABASE_URL — must start with https://\n' +
      'Current value:', url, '\n',
      err
    )
    return createClient(SSR_URL, SSR_KEY)
  }
}

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for admin client')
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}