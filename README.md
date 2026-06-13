# Lumnix SaaS

AI-powered e-commerce research platform with MCP (Model Context Protocol) server. 19 tools for Amazon, Alibaba, and AliExpress product research.

Live: lumnix.dev
npm: lumnix@0.2.1

## What It Does

Ask your AI to find winning products, vet suppliers, and calculate margins in one conversation. Your AI calls Lumnix and returns structured data with revenue estimates, competition analysis, and profit margins.

## Tech Stack
- Frontend: Next.js 16, React 19, Tailwind CSS
- Backend: Supabase (PostgreSQL, Auth, RLS)
- Payments: Stripe (3-tier: Free, Pro $29, Business $99)
- AI Protocol: MCP (JSON-RPC 2.0)
- Deployment: Vercel
- Language: TypeScript (end-to-end)

## Security
- Row-level security on all 12 database tables
- SHA-256 hashed API keys (never plaintext)
- Per-platform rate limiting (per-user, per-key, per-IP)
- Stripe webhook signature verification
- Server-only write access to billing tables

## Testing
- 698 passing tests (unit + integration)
- End-to-end payment flow tests

## Results
- Listed on 6 MCP directories
- 3-tier Stripe billing in live mode
- Production-deployed with real users
- Works with Claude Desktop, Cursor, Windsurf, Cline, and any MCP client

## License
MIT
