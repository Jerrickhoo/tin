// Phase 6 will clear Dexie, the outbox, and service-worker caches here so that
// logout on a shared machine isn't theatre (ROADMAP 6.6). The online-only build
// keeps nothing locally beyond Supabase's own session storage, which
// auth.signOut() already removes — so this is a deliberate no-op for now.
export async function wipeLocalCaches(): Promise<void> {}
