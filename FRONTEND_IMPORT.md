# Frontend source import

Source: https://github.com/hitakshiA/Manthan

Commit: 139ced5a272ff34e7c8edd2f9845da8c11cde872

The `manthan-ui/` subtree was copied without changes into `frontend/`. The source license is preserved in `LICENSE.manthan`. No backend, agent, database schema, root deployment infrastructure, secrets, or Git history was copied.

The frontend retains Manthan branding and its client-side API/authentication integrations. Backend-dependent features require a future Peeblo backend; they are not standalone functionality. The copied app also expects `VITE_CLERK_PUBLISHABLE_KEY` for its existing authentication provider.

Run from `frontend/`: `npm ci`, then `npm run dev`.

## Import validation

- All 129 frontend source files matched the upstream Git blob hashes.
- Dependencies installed with `npm ci`.
- `npm run build` passed (upstream chunk-size and deprecated configuration warnings).
- `npm run typecheck` reported 16 existing diagnostics across 8 source files; the imported source was left unchanged.
- No browser functionality was verified; Clerk configuration and backend services are not included.
