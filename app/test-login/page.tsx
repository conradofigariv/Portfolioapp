import { redirect } from 'next/navigation'

// The test-account sign-in lives at /auth/test-login (under `auth`, a reserved
// name no username can take). This only catches the shorter address people
// naturally type. See app/lib/test-account.ts.
export default function TestLoginRedirect() {
  redirect('/auth/test-login')
}
