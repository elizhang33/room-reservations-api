# Room Reservations API (Render + Postgres)

## Endpoints
- GET  `/`                 → health check
- POST `/reserve`          → create reservation
- GET  `/get?id=UUID`      → fetch reservation
- POST `/update`           → update fields
- POST `/cancel`           → delete by id
- GET  `/list?userId=UID`  → list a user's reservations

## Env
- `DATABASE_URL` → Postgres connection string from Render
- `PORT` → provided by Render automatically
