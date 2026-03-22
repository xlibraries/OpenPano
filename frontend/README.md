# OpenPano Frontend

Next.js + TypeScript web interface for the panorama viewer.

## Setup

```bash
npm install
```

## Configuration

Create `.env.local` from the example (or set env vars):

```bash
cp .env.local.example .env.local
```

| Variable | Default | Description |
|----------|---------|-------------|
| `API_URL` | `http://localhost:8080` | Backend API URL |
| `ALLOWED_DEV_ORIGINS` | — | Comma-separated allowed dev origins |

## Run

```bash
npm run dev
# Open http://localhost:3000
```

Requires the backend running at `API_URL`.

## Build for Production

```bash
npm run build
npm start
```
