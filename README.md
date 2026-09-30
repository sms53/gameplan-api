# Din Game Plan API

`POST /api/chat` is an internal server-to-server endpoint used by the Netlify
Game Plan generation function. It requires `GAMEPLAN_INTERNAL_API_SECRET` in
the Vercel server environment and the matching `X-Gameplan-Internal-Key`
request header. The secret must never be sent by browser code.

The endpoint accepts JSON with exactly one `messages` entry: a single user
message containing the Game Plan prompt. Model and `max_tokens` are fixed in
the server function. The route rejects other methods, unauthenticated calls,
non-JSON bodies, extra fields, and oversized prompts before contacting
Anthropic.

Set `GAMEPLAN_INTERNAL_API_SECRET` separately for Vercel Preview and Production
environments. Do not put a real value in this repository or in `.env.example`.
Production remains unchanged until a coordinated release also configures the
matching Netlify server environment.
