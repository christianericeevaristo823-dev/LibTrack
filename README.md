# LibTrack — Academic Starter Package

This package follows the proposal's intended stack: Ionic/React mobile-friendly interface, FastAPI API, and PostgreSQL-compatible data layer. The backend defaults to SQLite only to make local experimentation easier; set `DATABASE_URL` for PostgreSQL.

## Folders
- `backend/`: FastAPI + SQLAlchemy starter API
- `frontend/`: Ionic React catalog prototype
- `docs/`: project documentation and defense notes
- `LibTrack_Documentation.docx`: formal draft
- `LibTrack_Presentation.pptx`: presentation draft

## Start backend
```bash
cd backend
python -m venv .venv
# activate the environment
pip install -r requirements.txt
uvicorn main:app --reload
```
Visit `http://127.0.0.1:8000/docs` to create sample users/books and record borrow/return transactions.

## Start frontend
```bash
cd frontend
npm install
npm run start
```
If needed, copy `.env.example` to `.env` and update `VITE_API_URL`.

## Before real use
Authentication, authorization, secure secrets, input and concurrency review, audit logging, backups, privacy review, and deployment configuration are still required. Chapter 4 test results must be completed after actually testing the system; this package does not fabricate results.
