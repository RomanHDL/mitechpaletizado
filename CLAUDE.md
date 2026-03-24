# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MI-TECH Paletizado is an industrial pallet tracking dashboard. Data is stored in **MongoDB Atlas** (database: `mitech`), served via Node.js/Express backend, with a single-page HTML frontend.

## Architecture

### Frontend (index.html — single monolithic file)
- Pure HTML/CSS/JS — no build step, no framework
- Dark-themed dashboard with sidebar navigation and 5 views: Dashboard, Palets, Órdenes, Formulario, Configuración
- Uses Chart.js for charts (donut, bar, line), Flatpickr for date picker, Font Awesome for icons
- Data loaded via JSONP from `/api/sheet-proxy` (returns gviz-compatible format from MongoDB)
- Form writes via JSONP to `/api/sheet-write`
- `dashboard Paletizado.html` is a legacy dashboard version

### Backend (backend/)
- **server.js**: Express server on port 3009. Connects to MongoDB Atlas. Serves static files from project root.
  - `/api/pallets` — CRUD for pallets
  - `/api/dashboard` — aggregated dashboard data
  - `/api/mobile/*` — mobile app endpoints
  - `/api/sheet-proxy` — JSONP proxy that returns MongoDB data in gviz format (for frontend compatibility)
  - `/api/sheet-write` — JSONP write endpoint (for form compatibility)
  - `/api/health` — health check
- **models/Pallet.js**: Mongoose model for pallets collection
- **models/Error.js**: Mongoose model for pallet errors collection
- **routes/**: Express route modules (pallets, dashboard, mobile)
- **scripts/migrate-csv.js**: Migration script to import CSV data from Google Sheets into MongoDB

### Database (MongoDB Atlas — `mitech`)
Collections:
- `pallets` — palletId, cantidad, condicion, destino, turno, escaneadora, pedido, fecha, source, timestamps
- `palleterrors` — palletId, fecha, defecto, tipo, timestamps

### Mobile App (mobile/)
- React Native (Expo) app for barcode scanning
- Writes directly to Express API → MongoDB (no Google Sheets dependency)

## Commands

```bash
# Install backend dependencies
cd backend && npm install

# Create .env file with MongoDB URI
echo "MONGODB_URI=mongodb+srv://..." > backend/.env
echo "PORT=3009" >> backend/.env

# Start server (API + serves frontend at http://localhost:3009)
cd backend && node server.js

# Migrate CSV data from Google Sheets to MongoDB
# First export sheets as CSV to backend/scripts/anterior.csv and formulario.csv
cd backend && npm run migrate
```

## Key Conventions

- The project language is Spanish (UI labels, variable names, comments, commit messages)
- All frontend code lives in a single `index.html` file — CSS in `<style>`, JS in `<script>` at the bottom
- The backend uses dotenv for configuration — never hardcode credentials
- Server port: 3009 (configured via PORT env var)
- `.env` files are gitignored
