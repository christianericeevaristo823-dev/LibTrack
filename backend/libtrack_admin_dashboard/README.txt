LIBTRACK ADMIN DASHBOARD UPDATE

Replace frontend/src/main.tsx and frontend/src/theme.css.
Admin layout appears only when login API returns role="admin".
Uses existing /auth/login, /auth/register, and /books endpoints.
Member/borrow transaction controls are not implemented because the existing backend endpoints were not provided.
Back up files first. Do not replace .env, backend/main.py, or the database.
