// Values shared by the backend (server.ts) and the frontend (app.tsx).
//
// This module exists so app.tsx never imports a *value* from server.ts.
// A type-only import is erased from the frontend bundle; a value import is
// not, and would drag zod and the node: builtins into it.

/**
 * Realtime channel the server publishes on and the Prompts panel subscribes
 * to. The payload is `{ threadId }` so a panel ignores signals for threads it
 * is not showing.
 */
export const PROMPTS_CHANGED_CHANNEL = "prompts-changed";
