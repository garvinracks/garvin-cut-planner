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
      '[supabase] NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is not set. ' +
        'Add these to your Vercel project environment variables.'
    )
    return createClient(SSR_URL, SSR_KEY)
  }

  return createClient(url, key)
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