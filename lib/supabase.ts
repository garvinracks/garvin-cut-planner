import { createClient } from '@supabase/supabase-js'

// Placeholder used during SSR / static prerender so Next.js can build the HTML
// shell without needing real credentials. All actual data fetching happens
// client-side after hydration.
const SSR_URL = 'https://placeholder.supabase.co'
const SSR_KEY = 'placeholder'

export function createBrowserClient() {
  // During SSR / static prerender there is no browser — return a safe no-op
  // client. The real client is recreated in the browser via useMemo.
  if (typeof window === 'undefined') {
    return createClient(SSR_URL, SSR_KEY)
  }

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
    return createClient(url, key)
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