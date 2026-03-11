# Polymarket Copilot

Account-linked dashboard for Polymarket. Built with Next.js 14 (App Router), TypeScript, Tailwind CSS, shadcn/ui, Prisma, and PostgreSQL.

## Stack

- **Next.js 14** – App Router, React Server Components
- **TypeScript** – Strict mode
- **Tailwind CSS** – Utility-first styling, dark mode
- **shadcn/ui** – Button, Card, Separator, Sheet
- **Prisma** – PostgreSQL ORM
- **Zod** – Config validation

## Getting started

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Environment**

   Copy `.env.example` to `.env` and set `DATABASE_URL` for PostgreSQL. Optionally set `POLYMARKET_HOST` and `POLYMARKET_CHAIN_ID`.

3. **Database**

   ```bash
   npx prisma migrate dev
   ```

4. **Run dev server**

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000).

## Routes

| Route | Description |
|-------|-------------|
| `/` | Dashboard (overview) |
| `/markets` | Markets list (placeholder) |
| `/portfolio` | Portfolio & positions (placeholder) |
| `/settings/polymarket` | Connect MetaMask, set funder/proxy address, save connection |
| `/api/health` | Health check – returns `{ ok: true }` |
| `/api/polymarket/connection` | GET/POST – fetch or save EOA + funder + signature type (stored in `ConnectedWallet`) |

## Project structure

- `app/` – App Router pages and layouts
- `components/` – UI and dashboard shell (sidebar, header)
- `lib/` – Config, DB (Prisma), Polymarket placeholders, utils
- `types/` – Polymarket-related types
- `prisma/` – Schema and migrations

Polymarket integration is stubbed under `lib/polymarket/` and `lib/crypto.ts`; replace with real API and auth when ready. No trading logic is included yet.

## Scripts

- `npm run dev` – Development server
- `npm run build` – Production build
- `npm run start` – Start production server
- `npm run lint` – ESLint
