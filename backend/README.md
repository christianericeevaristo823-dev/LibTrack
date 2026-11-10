# LibTrack API (starter)

## Run locally
1. Install Python 3.11+.
2. `python -m venv .venv`
3. Activate the virtual environment.
4. `pip install -r requirements.txt`
5. For quick development, the default uses a local SQLite database. For PostgreSQL, set `DATABASE_URL` using `.env.example` (export it in your shell or use your environment manager).
6. `uvicorn main:app --reload`
7. Open `http://127.0.0.1:8000/docs`.

## Implemented starter endpoints
- `GET /health`
- `POST/GET /users`
- `POST/GET /books`, `GET /books/{book_id}`
- `POST /borrowings`, `GET /borrowings`
- `POST /borrowings/{borrowing_id}/return`
- `GET /reports/summary`

## Important limitations
This is a development starter, not production-ready. It does not yet implement password-based authentication, role-based authorization enforcement, audit logs, password reset, deployment hardening, or a complete Ionic interface. Do not expose it publicly or use real student data until those are implemented and reviewed. CORS is permissive for local development and must be restricted before deployment.
