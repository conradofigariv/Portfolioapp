import { Instrument_Sans } from 'next/font/google'
import { getUser } from './lib/supabase/server'
import { redirect } from 'next/navigation'
import LandingPage from './components/LandingPage'

const instrumentSans = Instrument_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
})

// The product landing and the sign-in screen are the same page: there is
// nothing to pitch that isn't also the thing you sign in to try. A signed-in
// visitor has nothing to do here, so they go straight to their editor.
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; reason?: string }>
}) {
  const user = await getUser()
  if (user) redirect('/admin')

  const { error, reason } = await searchParams

  return (
    <div className={`${instrumentSans.className} bg-[#08080a] text-[#f4f4f5] antialiased overflow-x-hidden`}>
      <LandingPage error={error} reason={reason} />

      <footer className="flex flex-wrap items-center justify-end gap-5 px-5 sm:px-9 lg:px-[72px] py-7 pb-10 border-t border-white/[0.08] text-sm text-[#71717a]">
        <span>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  )
}
