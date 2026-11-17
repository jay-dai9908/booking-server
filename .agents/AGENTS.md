# Workspace Rules

- Mem0 user_id: proj-web-booking-system
- Mem0 topics: `product-decisions`, `kiosk-api-contract`, `kiosk-handoff`, `kiosk-protocol-v1`, `kiosk-firmware-local`, `self-service-impl`, `kiosk-server-impl`, `billing-engine`, `shop-closing-print`, `booking-flow`, `infra-pitfalls`, `architecture`, `database`, `auth-api`, `dev-deploy`, `seat-allocator`, `frontend-conventions`, `floor-checkout-impl`, `seat-layout-board-coupling`, `windows-test-infra`
- Environment Preference: The user is currently developing locally. All instructions, commands, and troubleshooting should default to the local Windows environment (e.g., `npm run dev`, `localhost:5173`, local Docker PostgreSQL) unless the user explicitly requests cloud/VM operations.
- Cloud/VM Deployment Path: The repository folder on the user's remote VM is `~/web-booking-system` (NEVER use `~/booking-server`). When providing VM deployment commands, always use:
  `cd ~/web-booking-system && git pull origin main && cd frontend && npm run build && cd .. && pm2 restart all` (or just `git pull origin main && cd frontend && npm run build && cd .. && pm2 restart all` when already inside the directory).
