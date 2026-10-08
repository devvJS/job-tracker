/** The sign-in page. The server redirects here when there is no session. */
export function LoginPage() {
  return (
    <section data-testid="login-page" className="mx-auto mt-16 max-w-md rounded border border-muted/40 p-8">
      <h1 className="text-2xl font-bold text-accent-green">Sign in</h1>
      <p className="mt-3 text-ink/80">This tracker is private. Sign in with the allowed GitHub account to continue.</p>
      {/* A plain link: the OAuth flow is a full-page navigation through the server. */}
      <a
        data-testid="signin"
        href="/job-tracker/api/auth/login"
        className="mt-6 inline-block rounded border border-accent-green px-4 py-2 font-mono text-accent-green hover:bg-accent-green hover:text-charcoal"
      >
        Sign in with GitHub
      </a>
    </section>
  );
}
