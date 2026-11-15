from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo
import time
import os
import re
import secrets
import random
import uuid
import json
import zipfile
import shutil
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import urlopen
from pathlib import Path
from dotenv import load_dotenv
from typing import Optional

import jwt
from jwt.exceptions import InvalidTokenError
from pwdlib import PasswordHash

from fastapi import FastAPI, HTTPException, Depends, status, File, UploadFile, Form
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from supabase import create_client
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, ConfigDict

from sqlalchemy import (
    create_engine, String, Integer, Float, Date, DateTime, Text,
    ForeignKey, Boolean, select, inspect, text, func,
)
from sqlalchemy.orm import (
    DeclarativeBase, Mapped, mapped_column,
    sessionmaker, Session,
)

# =========================================================
# CONFIGURATION
# =========================================================

# Keep the SQLite database beside this main.py file so that starting
# Uvicorn from a different working directory cannot create a second database.
BACKEND_DIR = Path(__file__).resolve().parent
load_dotenv(BACKEND_DIR / ".env", encoding="utf-8-sig")
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    DATABASE_URL = f"sqlite:///{(BACKEND_DIR / 'libtrack_dev.db').as_posix()}"

# Research PDFs are stored on the backend disk, never in the database.
RESEARCH_PDF_DIR = Path(__file__).resolve().parent / "uploads" / "research_pdfs"
RESEARCH_PDF_DIR.mkdir(parents=True, exist_ok=True)
MAX_RESEARCH_PDF_BYTES = 25 * 1024 * 1024  # 25 MB per PDF

BOOK_COVER_DIR = BACKEND_DIR / "uploads" / "book_covers"
BOOK_COVER_DIR.mkdir(parents=True, exist_ok=True)
MAX_BOOK_COVER_BYTES = 5 * 1024 * 1024  # 5 MB

# Local E-Book Library PDFs. Admin uploads PDFs; students can read them.
EBOOK_PDF_DIR = BACKEND_DIR / "uploads" / "ebooks"
EBOOK_PDF_DIR.mkdir(parents=True, exist_ok=True)
MAX_EBOOK_PDF_BYTES = 50 * 1024 * 1024  # 50 MB per PDF
MAX_EBOOK_ZIP_BYTES = 2 * 1024 * 1024 * 1024  # allow ZIP archives up to 2 GB
MAX_EBOOK_ZIP_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB total extracted PDFs
MAX_EBOOK_ZIP_FILES = 5000

# Supabase Storage (service-role key stays on the backend only).
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
SUPABASE_ENABLED = bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) if SUPABASE_ENABLED else None

BUCKET_EBOOKS = "ebooks"
BUCKET_COVERS = "book-covers"
BUCKET_RESEARCH = "research-pdfs"
BUCKET_PROFILE_PHOTOS = "profile-photos"
BUCKET_RECEIPTS = "receipt-attachments"
MAX_RECEIPT_BYTES = 5 * 1024 * 1024
ALLOWED_RECEIPT_TYPES = {"image/jpeg", "image/png", "image/webp", "application/pdf"}

# Cache e-book storage paths to avoid rescanning Supabase for every PDF request.
EBOOK_KEY_CACHE = {}
EBOOK_LIST_CACHE = {"created_at": 0.0, "items": None}
EBOOK_LIST_CACHE_TTL = 30.0  # seconds; keeps repeat catalog opens fast


def invalidate_ebook_list_cache():
    EBOOK_LIST_CACHE["created_at"] = 0.0
    EBOOK_LIST_CACHE["items"] = None


def storage_upload(bucket: str, key: str, contents: bytes, content_type: str):
    if not supabase:
        raise RuntimeError("Supabase Storage is not configured.")
    return supabase.storage.from_(bucket).upload(
        key, contents,
        file_options={"content-type": content_type, "upsert": "true"},
    )


def storage_download(bucket: str, key: str) -> bytes:
    if not supabase:
        raise RuntimeError("Supabase Storage is not configured.")
    return supabase.storage.from_(bucket).download(key)


def storage_remove(bucket: str, key: str):
    if supabase:
        return supabase.storage.from_(bucket).remove([key])
    return None


def storage_walk(bucket: str, prefix: str = ""):
    """Recursively list object keys in a Supabase bucket."""
    if not supabase:
        return []
    found = []
    storage = supabase.storage.from_(bucket)
    def walk(folder: str):
        offset = 0
        while True:
            entries = storage.list(folder, options={"limit": 100, "offset": offset})
            if not entries:
                break
            for entry in entries:
                name = entry.get("name") if isinstance(entry, dict) else getattr(entry, "name", None)
                if not name:
                    continue
                key = f"{folder}/{name}" if folder else name
                metadata = entry.get("metadata") if isinstance(entry, dict) else getattr(entry, "metadata", None)
                entry_id = entry.get("id") if isinstance(entry, dict) else getattr(entry, "id", None)
                if metadata is None and entry_id is None:
                    walk(key)
                else:
                    found.append(key)
            if len(entries) < 100:
                break
            offset += len(entries)
    walk(prefix.strip("/"))
    return found


def storage_pdf_response(bucket: str, key: str, filename: str):
    try:
        contents = storage_download(bucket, key)
    except Exception as exc:
        raise HTTPException(status_code=404, detail="The stored PDF could not be found.") from exc
    return Response(
        content=contents,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"', "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=3600"},
    )

SECRET_KEY = os.getenv("LIBTRACK_SECRET_KEY")

if not SECRET_KEY or len(SECRET_KEY) < 32:
    raise RuntimeError(
        "Set LIBTRACK_SECRET_KEY to a random secret "
        "of at least 32 characters before starting LibTrack."
    )

ALGORITHM = "HS256"
# Persistent sign-in window: users stay signed in for up to 30 days unless they log out.
ACCESS_TOKEN_MINUTES = 60 * 24 * 30

password_hashing = PasswordHash.recommended()
bearer_scheme = HTTPBearer(auto_error=False)

connect_args = (
    {"check_same_thread": False}
    if DATABASE_URL.startswith("sqlite")
    else {}
)

engine = create_engine(
    DATABASE_URL,
    connect_args=connect_args,
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
)

class Base(DeclarativeBase):
    pass

# =========================================================
# DATABASE MODELS
# =========================================================

class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(
        Integer, primary_key=True, index=True
    )
    full_name: Mapped[str] = mapped_column(String(150))
    email: Mapped[str] = mapped_column(
        String(255), unique=True, index=True
    )
    role: Mapped[str] = mapped_column(
        String(20), default="student"
    )
    active: Mapped[bool] = mapped_column(
        Boolean, default=True
    )
    password_hash: Mapped[Optional[str]] = mapped_column(
        String(255), nullable=True
    )

    # Dagdag na registration fields.
    # Nullable para compatible sa mga existing accounts.
    student_id: Mapped[Optional[str]] = mapped_column(
        String(50), unique=True, nullable=True, index=True
    )
    course: Mapped[Optional[str]] = mapped_column(
        String(100), nullable=True
    )
    year: Mapped[Optional[str]] = mapped_column(
        String(30), nullable=True
    )
    section: Mapped[Optional[str]] = mapped_column(
        String(50), nullable=True
    )
    username: Mapped[Optional[str]] = mapped_column(
        String(50), unique=True, nullable=True, index=True
    )
    profile_photo_url: Mapped[Optional[str]] = mapped_column(
        String(1000), nullable=True
    )
    borrowing_suspended: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )

class LoginSession(Base):
    __tablename__ = "login_sessions"

    id: Mapped[int] = mapped_column(
        Integer, primary_key=True, index=True
    )
    token_id: Mapped[str] = mapped_column(
        String(100), unique=True, index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow
    )
    last_seen: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, index=True
    )
    logged_out_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )

class Book(Base):
    __tablename__ = "books"

    id: Mapped[int] = mapped_column(
        Integer, primary_key=True, index=True
    )
    title: Mapped[str] = mapped_column(
        String(250), index=True
    )
    author: Mapped[str] = mapped_column(
        String(200), index=True
    )
    category: Mapped[str] = mapped_column(
        String(100), default="General"
    )
    isbn: Mapped[Optional[str]] = mapped_column(
        String(30), nullable=True
    )
    # Added library call number field; nullable to preserve existing records.
    call_number: Mapped[Optional[str]] = mapped_column(
        String(100), nullable=True
    )
    description: Mapped[Optional[str]] = mapped_column(
        Text, nullable=True
    )
    cover_image: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    total_copies: Mapped[int] = mapped_column(
        Integer, default=1
    )
    available_copies: Mapped[int] = mapped_column(
        Integer, default=1
    )
    # Inactive legacy titles are hidden from the current catalog while
    # historical borrowing records remain intact.
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

class Research(Base):
    __tablename__ = "research_materials"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    title: Mapped[str] = mapped_column(String(300), index=True)
    authors: Mapped[str] = mapped_column(String(300), default="Not listed")
    teacher: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)
    year: Mapped[str] = mapped_column(String(30), default="Not specified")
    course: Mapped[str] = mapped_column(String(100), index=True)
    subject: Mapped[str] = mapped_column(String(150), default="General")
    research_type: Mapped[str] = mapped_column(String(80), default="Research Paper")
    abstract: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    verification_status: Mapped[str] = mapped_column(String(40), default="Unverified")
    campus: Mapped[str] = mapped_column(String(150), default="NEUST Peñaranda Off-Campus")
    url: Mapped[str] = mapped_column(String(1000), default="")
    pdf_filename: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    cover_image: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    note: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class AcademicCourse(Base):
    __tablename__ = "academic_courses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    code: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AcademicCourseCreate(BaseModel):
    code: str = Field(min_length=2, max_length=40)


class SystemSetting(Base):
    __tablename__ = "system_settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class WeekendNoticeUpdate(BaseModel):
    enabled: bool = True
    time: str = Field(default="07:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    message: str = Field(default="Book borrowing is unavailable on Saturdays and Sundays. Please visit the library during regular operating days (Monday-Friday).", min_length=1, max_length=1000)


class BorrowingScheduleUpdate(BaseModel):
    enabled: bool = True
    days: list[str] = Field(default_factory=lambda: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"])
    open_time: str = "08:00"
    close_time: str = "17:00"
    message: str = Field(default="Book borrowing is currently unavailable. Please check the library borrowing schedule.", max_length=500)


DEFAULT_BORROWING_SCHEDULE = {
    "enabled": True,
    "days": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    "open_time": "08:00",
    "close_time": "17:00",
    "message": "Book borrowing is currently unavailable. Please check the library borrowing schedule.",
}
VALID_BORROWING_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


class LibraryScheduleUpdate(BaseModel):
    schedule: dict[str, dict[str, str | bool]]


class Borrowing(Base):
    __tablename__ = "borrowings"

    id: Mapped[int] = mapped_column(
        Integer, primary_key=True, index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id")
    )
    book_id: Mapped[int] = mapped_column(
        ForeignKey("books.id")
    )
    borrowed_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow
    )
    due_date: Mapped[date] = mapped_column(Date)
    returned_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )
    status: Mapped[str] = mapped_column(
        String(20), default="borrowed"
    )

class ProblemReport(Base):
    __tablename__ = "problem_reports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    category: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    admin_note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class LostBookCase(Base):
    __tablename__ = "lost_book_cases"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    borrowing_id: Mapped[int] = mapped_column(ForeignKey("borrowings.id"), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"), index=True)
    report_date: Mapped[date] = mapped_column(Date, default=date.today)
    market_value: Mapped[float] = mapped_column(Float, default=0)
    processing_fee: Mapped[float] = mapped_column(Float, default=50)
    additional_fine: Mapped[float] = mapped_column(Float, default=0)
    amount_due: Mapped[float] = mapped_column(Float, default=50)
    deadline: Mapped[date] = mapped_column(Date)
    case_type: Mapped[str] = mapped_column(String(20), default="lost")
    resolution_status: Mapped[str] = mapped_column(String(20), default="unsettled")
    resolution_note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class UserNotification(Base):
    __tablename__ = "user_notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    title: Mapped[str] = mapped_column(String(180))
    message: Mapped[str] = mapped_column(Text)
    notification_type: Mapped[str] = mapped_column(String(40), default="library")
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class LostBookReport(BaseModel):
    market_value: float = Field(ge=0, le=1000000)
    additional_fine: float = Field(default=0, ge=0, le=1000000)
    case_type: str = Field(default="lost", pattern=r"^(lost|damaged)$")
    deadline: Optional[date] = None
    note: Optional[str] = Field(default=None, max_length=1000)


class LostBookResolution(BaseModel):
    resolution_status: str = Field(pattern=r"^(paid|replaced|waived)$")
    note: Optional[str] = Field(default=None, max_length=1000)


# =========================================================
# DATABASE INITIALIZATION AND SAFE MIGRATION
# =========================================================

Base.metadata.create_all(bind=engine)

def migrate_database():
    columns = {
        column["name"]
        for column in inspect(engine).get_columns("users")
    }

    migrations = {
        "password_hash": "VARCHAR(255)",
        "student_id": "VARCHAR(50)",
        "course": "VARCHAR(100)",
        "year": "VARCHAR(30)",
        "section": "VARCHAR(50)",
        "username": "VARCHAR(50)",
        "profile_photo_url": "VARCHAR(1000)",
        "borrowing_suspended": "BOOLEAN NOT NULL DEFAULT 0",
    }

    with engine.begin() as connection:
        for column_name, column_type in migrations.items():
            if column_name not in columns:
                connection.execute(
                    text(
                        f"ALTER TABLE users ADD COLUMN "
                        f"{column_name} {column_type}"
                    )
                )

        connection.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS "
                "ix_users_student_id ON users (student_id)"
            )
        )
        connection.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS "
                "ix_users_username ON users (username)"
            )
        )

        # Safe additive migration: preserve all existing research records.
        research_columns = {column["name"] for column in inspect(connection).get_columns("research_materials")}
        for column_name, column_type in {"research_type": "VARCHAR(80) DEFAULT 'Research Paper'", "abstract": "TEXT", "verification_status": "VARCHAR(40) DEFAULT 'Unverified'", "teacher": "VARCHAR(300)"}.items():
            if column_name not in research_columns:
                connection.execute(text(f"ALTER TABLE research_materials ADD COLUMN {column_name} {column_type}"))

        research_columns = {
            column["name"]
            for column in inspect(connection).get_columns("research_materials")
        }
        if "pdf_filename" not in research_columns:
            connection.execute(
                text(
                    "ALTER TABLE research_materials "
                    "ADD COLUMN pdf_filename VARCHAR(255)"
                )
            )
        if "cover_image" not in research_columns:
            connection.execute(
                text("ALTER TABLE research_materials ADD COLUMN cover_image VARCHAR(500)")
            )

        # Add the call_number column without removing or rewriting existing books.
        book_columns = {
            column["name"]
            for column in inspect(connection).get_columns("books")
        }
        if "call_number" not in book_columns:
            connection.execute(
                text("ALTER TABLE books ADD COLUMN call_number VARCHAR(100)")
            )
        if "description" not in book_columns:
            connection.execute(
                text("ALTER TABLE books ADD COLUMN description TEXT")
            )
        if "cover_image" not in book_columns:
            connection.execute(
                text("ALTER TABLE books ADD COLUMN cover_image VARCHAR(500)")
            )
        if "is_active" not in book_columns:
            connection.execute(
                text("ALTER TABLE books ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT 1")
            )

migrate_database()

# =========================================================
# FASTAPI APPLICATION
# =========================================================

app = FastAPI(
    title="LibTrack API",
    version="1.0.0",
    description=(
        "Library Management System with Student and Admin Login"
    ),
)

if not SUPABASE_ENABLED:
    app.mount("/uploads/book_covers", StaticFiles(directory=str(BOOK_COVER_DIR)), name="book_covers")

app.add_middleware(
    CORSMiddleware,
  allow_origins=[
     "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://192.168.100.44:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://libtrack-poc.vercel.app",
    ],
    allow_credentials=False,
    allow_methods=[
        "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"
    ],
    allow_headers=["Authorization", "Content-Type"],
)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
        # =========================================================
# REQUEST SCHEMAS
# =========================================================

class RegisterRequest(BaseModel):
    profile_photo_data_url: Optional[str] = Field(default=None, max_length=4200000)
    full_name: str = Field(min_length=2, max_length=150)
    student_id: str = Field(min_length=1, max_length=50)
    course: str = Field(min_length=1, max_length=100)
    year: str = Field(min_length=1, max_length=30)
    section: str = Field(min_length=1, max_length=50)
    email: str = Field(min_length=3, max_length=255)
    username: str = Field(min_length=3, max_length=50)
    password: str = Field(min_length=10, max_length=128)

class FacultyRegisterRequest(BaseModel):
    full_name: str = Field(min_length=2, max_length=150)
    email: str = Field(min_length=3, max_length=255)
    username: str = Field(min_length=3, max_length=50)
    password: str = Field(min_length=10, max_length=128)
    profile_photo_data_url: Optional[str] = Field(default=None, max_length=4200000)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=10, max_length=128)


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=128)

class UserCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    full_name: str = Field(min_length=2, max_length=150)
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=10, max_length=128)
    role: str = "student"

class UserUpdate(BaseModel):
    """Partial account update for the Admin Dashboard."""
    model_config = ConfigDict(extra="forbid")

    full_name: Optional[str] = Field(default=None, min_length=2, max_length=150)
    student_id: Optional[str] = Field(default=None, min_length=1, max_length=50)
    course: Optional[str] = Field(default=None, min_length=1, max_length=100)
    year: Optional[str] = Field(default=None, min_length=1, max_length=30)
    section: Optional[str] = Field(default=None, min_length=1, max_length=50)
    email: Optional[str] = Field(default=None, min_length=3, max_length=255)
    username: Optional[str] = Field(default=None, min_length=3, max_length=50)
    role: Optional[str] = None
    active: Optional[bool] = None

class BookCreate(BaseModel):
    title: str = Field(min_length=1, max_length=250)
    author: str = Field(min_length=1, max_length=200)
    category: str = Field(
        default="General", min_length=1, max_length=100
    )
    isbn: Optional[str] = Field(default=None, max_length=30)
    call_number: Optional[str] = Field(default=None, max_length=100)
    description: Optional[str] = Field(default=None, max_length=5000)
    total_copies: int = Field(default=1, ge=1)

class BookUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: Optional[str] = Field(
        default=None, min_length=1, max_length=250
    )
    author: Optional[str] = Field(
        default=None, min_length=1, max_length=200
    )
    category: Optional[str] = Field(
        default=None, min_length=1, max_length=100
    )
    isbn: Optional[str] = Field(
        default=None, max_length=30
    )
    call_number: Optional[str] = Field(
        default=None, max_length=100
    )
    description: Optional[str] = Field(
        default=None, max_length=5000
    )
    total_copies: Optional[int] = Field(
        default=None, ge=1
    )

class ResearchCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=300)
    authors: str = Field(default="Not listed", max_length=300)
    teacher: Optional[str] = Field(default=None, max_length=300)
    year: str = Field(default="Not specified", max_length=30)
    course: str = Field(min_length=1, max_length=100)
    subject: str = Field(default="General", max_length=150)
    research_type: str = Field(default="Research Paper", max_length=80)
    abstract: Optional[str] = Field(default=None, max_length=10000)
    verification_status: str = Field(default="Unverified", max_length=40)
    campus: str = Field(default="NEUST Peñaranda Off-Campus", max_length=150)
    url: Optional[str] = Field(default=None, max_length=1000)
    note: Optional[str] = Field(default=None, max_length=1000)

class ResearchUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Optional[str] = Field(default=None, min_length=1, max_length=300)
    authors: Optional[str] = Field(default=None, max_length=300)
    teacher: Optional[str] = Field(default=None, max_length=300)
    year: Optional[str] = Field(default=None, max_length=30)
    course: Optional[str] = Field(default=None, min_length=1, max_length=100)
    subject: Optional[str] = Field(default=None, max_length=150)
    research_type: Optional[str] = Field(default=None, max_length=80)
    abstract: Optional[str] = Field(default=None, max_length=10000)
    verification_status: Optional[str] = Field(default=None, max_length=40)
    campus: Optional[str] = Field(default=None, max_length=150)
    url: Optional[str] = Field(default=None, max_length=1000)
    note: Optional[str] = Field(default=None, max_length=1000)

class BorrowCreate(BaseModel):
    user_id: Optional[int] = None
    book_id: int
    # Student borrowing requests do not choose a due date; Admin sets it on approval.
    due_date: Optional[date] = None


class BorrowApproval(BaseModel):
    due_date: date


class ProblemReportCreate(BaseModel):
    category: str = Field(min_length=2, max_length=100)
    description: str = Field(min_length=5, max_length=2000)


class ProblemReportUpdate(BaseModel):
    status: str = Field(pattern=r"^(pending|in_progress|resolved)$")
    admin_note: Optional[str] = Field(default=None, max_length=2000)

# =========================================================
# HELPER FUNCTIONS
# =========================================================

def clean_required(value: str, field_name: str) -> str:
    value = value.strip()

    if not value:
        raise HTTPException(
            status_code=422,
            detail=f"{field_name} cannot be empty.",
        )

    return value

def normalize_email(email: str) -> str:
    email = email.strip().lower()

    if (
        len(email) > 255
        or email.count("@") != 1
        or email.startswith("@")
        or email.endswith("@")
        or any(character.isspace() for character in email)
    ):
        raise HTTPException(
            status_code=422,
            detail="Enter a valid email address.",
        )

    return email

def hash_password(password: str) -> str:
    if len(password) < 10:
        raise HTTPException(
            status_code=422,
            detail="Password must be at least 10 characters.",
        )

    return password_hashing.hash(password)

def verify_password(
    plain_password: str,
    hashed_password: str,
) -> bool:
    return password_hashing.verify(
        plain_password, hashed_password
    )

def user_out(user: User):
    return {
        "id": user.id,
        "full_name": user.full_name,
        "student_id": user.student_id,
        "course": user.course,
        "year": user.year,
        "section": user.section,
        "username": user.username,
        "email": user.email,
        "role": user.role,
        "active": user.active,
        "profile_photo_url": user.profile_photo_url,
    }

def save_profile_photo(user: User, data_url: str):
    """Validate and store a small profile image in Supabase Storage."""
    if not SUPABASE_ENABLED:
        raise HTTPException(status_code=503, detail="Profile photo storage is not configured. Set Supabase Storage credentials.")
    import base64
    import binascii
    match = re.fullmatch(r"data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)", data_url or "")
    if not match:
        raise HTTPException(status_code=422, detail="Upload a JPG, PNG, or WEBP image.")
    mime_type, encoded = match.groups()
    try:
        contents = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=422, detail="Invalid image data.")
    if not contents or len(contents) > 3 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Profile photo must be 3 MB or smaller.")
    extension = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[mime_type]
    key = f"users/{user.id}/profile.{extension}"
    try:
        storage_upload(BUCKET_PROFILE_PHOTOS, key, contents, mime_type)
        public_url = supabase.storage.from_(BUCKET_PROFILE_PHOTOS).get_public_url(key)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not save profile photo: {exc}")
    user.profile_photo_url = str(public_url)
    return user.profile_photo_url


def book_out(book: Book):
    return {
        "id": book.id,
        "title": book.title,
        "author": book.author,
        "category": book.category,
        "isbn": book.isbn,
        "call_number": book.call_number,
        "description": book.description,
        "cover_image": (
            supabase.storage.from_(BUCKET_COVERS).get_public_url(book.cover_image.rsplit("/", 1)[-1])
            if supabase and book.cover_image and book.cover_image.startswith("/uploads/book_covers/")
            else book.cover_image
        ),
        "total_copies": book.total_copies,
        "available_copies": book.available_copies,
        "available": book.available_copies > 0,
        "is_active": book.is_active,
    }

def lost_book_case_out(record: LostBookCase):
    return {
        "id": record.id,
        "borrowing_id": record.borrowing_id,
        "user_id": record.user_id,
        "book_id": record.book_id,
        "report_date": record.report_date.isoformat(),
        "market_value": float(record.market_value or 0),
        "processing_fee": float(record.processing_fee or 0),
        "additional_fine": float(record.additional_fine or 0),
        "amount_due": float(record.amount_due or 0),
        "deadline": record.deadline.isoformat(),
        "case_type": record.case_type,
        "resolution_status": record.resolution_status,
        "resolution_note": record.resolution_note,
        "resolved_at": record.resolved_at.isoformat() if record.resolved_at else None,
    }


def borrowing_out(record: Borrowing):
    return {
        "id": record.id,
        "user_id": record.user_id,
        "book_id": record.book_id,
        "borrowed_at": (
            record.borrowed_at.isoformat()
            if record.borrowed_at else None
        ),
        "due_date": record.due_date.isoformat(),
        "returned_at": (
            record.returned_at.isoformat()
            if record.returned_at else None
        ),
        "status": record.status,
        "overdue": (
            record.status == "borrowed"
            and record.due_date < date.today()
        ),
    }

# =========================================================
# AUTHENTICATION AND AUTHORIZATION
# =========================================================

def create_access_token(user: User, token_id: str) -> str:
    expires = datetime.utcnow() + timedelta(
        minutes=ACCESS_TOKEN_MINUTES
    )

    return jwt.encode(
        {
            "sub": str(user.id),
            "jti": token_id,
            "exp": expires,
        },
        SECRET_KEY,
        algorithm=ALGORITHM,
    )

def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(
        bearer_scheme
    ),
    db: Session = Depends(get_db),
) -> User:
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Please log in with a valid token.",
        headers={"WWW-Authenticate": "Bearer"},
    )

    if credentials is None:
        raise unauthorized

    try:
        payload = jwt.decode(
            credentials.credentials,
            SECRET_KEY,
            algorithms=[ALGORITHM],
        )
        user_id = int(payload["sub"])
    except (
        InvalidTokenError,
        ValueError,
        KeyError,
        TypeError,
    ):
        raise unauthorized

    user = db.get(User, user_id)
    token_id = payload.get("jti")

    if not user or not user.active or not token_id:
        raise unauthorized

    active_session = db.scalar(
        select(LoginSession).where(
            LoginSession.token_id == token_id,
            LoginSession.user_id == user_id,
            LoginSession.logged_out_at.is_(None),
        )
    )
    if active_session is None:
        raise unauthorized

    return user

def require_admin(
    user: User = Depends(get_current_user),
) -> User:
    if user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required.",
        )

    return user

# =========================================================
# FIRST ADMIN ACCOUNT BOOTSTRAP
# =========================================================

@app.on_event("startup")
def create_first_admin():
    admin_email = os.getenv("LIBTRACK_ADMIN_EMAIL")
    admin_password = os.getenv("LIBTRACK_ADMIN_PASSWORD")
    admin_name = os.getenv(
        "LIBTRACK_ADMIN_NAME", "LibTrack Administrator"
    )

    if not admin_email or not admin_password:
        return

    email = admin_email.strip().lower()

    if len(admin_password) < 10:
        raise RuntimeError(
            "LIBTRACK_ADMIN_PASSWORD must be at least 10 characters."
        )

    with SessionLocal() as db:
        existing = db.scalar(
            select(User).where(User.email == email)
        )

        if existing:
            if existing.role != "admin":
                raise RuntimeError(
                    "Configured admin email already belongs to "
                    "a non-admin account. Choose a different email."
                )
            return

        admin = User(
            full_name=admin_name.strip()
            or "LibTrack Administrator",
            email=email,
            role="admin",
            active=True,
            password_hash=hash_password(admin_password),
        )

        db.add(admin)
        db.commit()

@app.on_event("startup")
def seed_penaranda_off_campus_research():
    """Add missing starter and supplied THE SEED BSIT records without deleting existing data."""
    starter_research = [{'title': 'Perceived Usefulness of Logic Circuit Design in Enhancing Technical Proficiency Among BSIT Students in NEUST Peñaranda Off-Campus', 'authors': 'Joseph R. Del Carmen, Jodell R. Bulaclac, Emmanuel T. Santiago, Chrisandy B. Suarez, Jolina D. Santiago, Jonathan G. Alberto, and Rosalie B. Sison', 'year': '2026', 'course': 'BSIT', 'subject': 'Logic Circuits / Technical Proficiency', 'campus': 'NEUST Peñaranda Off-Campus — published student research', 'url': 'https://ijsred.com/volume9/issue1/IJSRED-V9I1P111.pdf', 'note': "Local NEUST Peñaranda Off-Campus study. It examined 84 BSIT students' experience designing and building a 7-segment logic-circuit display, including perceived effectiveness of logic-design concepts and hands-on technical proficiency. Published in International Journal of Scientific Research and Engineering Development, Volume 9, Issue 1 (2026)."}, {'title': 'The Impact of Artificial Intelligence Tools on the Coding Proficiency and Skill Development of IT Students', 'authors': 'Karl Joseph A. Austria', 'year': '2026', 'course': 'BSIT', 'subject': 'Artificial Intelligence / Programming', 'campus': 'NEUST Peñaranda Off-Campus — published student research', 'url': 'https://www.ijsred.com/volume9/issue2/IJSRED-V9I2P144.pdf', 'note': 'Local NEUST Peñaranda Off-Campus study about the use of AI tools in relation to coding proficiency and skill development among IT students. Read the publisher PDF for its methods, results, limitations, and recommendations. Published in International Journal of Scientific Research and Engineering Development, Volume 9, Issue 2 (2026).'}, {'title': 'A Needs Assessment on Establishing an IT Student Organization for Skills Development and Representation', 'authors': 'Jodell R. Bulaclac, Rechel B. Mananquil, Emmanuel G. Santiago, and Manuelito T. Santiago', 'year': '2025', 'course': 'BSIT', 'subject': 'Student Development / Organization', 'campus': 'NEUST Peñaranda Off-Campus — published student research', 'url': 'https://www.mijrd.com/papers/v5/i2/MIJRDV5I20004.pdf', 'note': 'Local NEUST Peñaranda Off-Campus needs assessment surveying 284 BSIT students about an IT student organization, skills-development activities, mentoring, and student representation. Published in Multidisciplinary International Journal of Research and Development, Volume 5, Issue 2 (2025).'}, {'title': 'A Project Feasibility Study on Establishing Funeral Home and Services Business in Peñaranda, Nueva Ecija (Placidus Funeral Home and Services)', 'authors': 'Joel M. Bidaure, Macy Hazel M. Noroña, Argin S. Delos Santos, Jayson V. Catacutan, Sherry Ann Solis, and Dan Mclean A. Abesamis', 'year': '2018', 'course': 'BSBA', 'subject': 'Marketing Management / Feasibility Study', 'campus': 'NEUST Peñaranda Off-Campus — student feasibility study copy', 'url': 'https://www.scribd.com/document/400799910/Feasibility-Study-On-Establishing-Funeral-Home-and-Services-Business-in-Penaranda-Nueva-Ecija-Placidus-Funeral-Home-and-Services', 'note': 'Local BSBA Marketing Management feasibility study submitted at NEUST Peñaranda Off-Campus in December 2018. It covers a proposed funeral-home business in Peñaranda and includes market, technical, organizational, and financial feasibility sections. Public copy is hosted on Scribd; use the linked source for reading and citation.'}, {'title': 'Ang Ugnayan ng Social Media sa mga Pamamaraan ng Pag-aaral at Pagganap sa Akademiko ng mga Mag-aaral sa Unang Antas sa NEUST Peñaranda Off-Campus sa Kursong Edukasyon (Taong Panuruan 2023–2024)', 'authors': 'Group 3 student research document; individual authors are not identified in the public listing', 'year': '2023–2024', 'course': 'BSED', 'subject': 'Social Media / Study Habits / Academic Performance', 'campus': 'NEUST Peñaranda Off-Campus — public student research copy', 'url': 'https://www.scribd.com/document/917604457/Group-3-Pananaliksik-Sa-FilDis-1', 'note': 'Student research document that identifies NEUST Peñaranda Off-Campus and BSED-1A as its locale/respondents. It studies the relationship between social-media use, study habits, and academic performance. Public copy is hosted on Scribd; verify the original with the authors or adviser before formally citing it.'}, {'title': 'The Level of Difficulties in English Speaking Skills of BSEd-English Students', 'authors': 'Group 4 student research proposal; individual authors are not identified in the public listing', 'year': 'Not stated', 'course': 'BSED-ENGLISH', 'subject': 'English Speaking / Language Learning', 'campus': 'NEUST Peñaranda Off-Campus — public student proposal copy', 'url': 'https://www.scribd.com/document/917604351/The-Level-of-Difficulties-in-English-Speaking-Skills-of-Bsed-English-Students', 'note': 'Student research proposal identifying BSEd-English students at NEUST Peñaranda Off-Campus as the target group. It focuses on perceived challenges in pronunciation, vocabulary, grammar, fluency, and comprehension. Public copy is hosted on Scribd; its status is a proposal, not a verified published journal article.'}, {'title': 'The Experimental Study of Peer Feedback on the Vocabulary Growth of BSEd-English Students', 'authors': 'Student research proposal; individual authors are not identified in the public listing', 'year': 'Not stated', 'course': 'BSED-ENGLISH', 'subject': 'Peer Feedback / Vocabulary Development', 'campus': 'NEUST Peñaranda Off-Campus — public student proposal copy', 'url': 'https://www.scribd.com/document/917605434/The-Experimental-Study-of-Peer-Feedback-on-the-Vocabulary-Growth-of-BSED-rev', 'note': 'Student research proposal identifying NEUST Peñaranda Off-Campus as the research locale. It proposes a pre-test/post-test design to examine peer feedback and vocabulary growth among BSEd-English students. Public copy is hosted on Scribd; it should be treated as a proposal unless a completed version is confirmed.'}]
    the_seed_research = [{'title': 'Quantitative Optimization in Applied Information Technology: Modeling Break-Even Analysis and Non-Linear Decision Metrics', 'authors': 'Klyde B. Gedo Cruz, Jhelvin D. De Guzman, Andrew James P. Garcia, Dionybert L. Madrid, Rovic A. Victoria, Val G. De Guzman', 'year': '2025', 'course': 'BSIT', 'subject': 'Information Technology', 'research_type': 'Applied Research Paper', 'abstract': 'Quantitative decision-making provides a structured framework for evaluating operational sustainability and profitability in applied software engineering and IT management. This paper examines the computational modeling of break -even analysis alongside line ar and non -linear cost-revenue functions. While traditional linear models offer a foundational baseline using static formulas, real-world operational environments exhibit complex non-linear behaviors such as market saturation, capacity limits, and variable cost fluctuations. By integrating differential calculus, specifically first-derivative evaluations, systems can dynamically locate critical turning points, optimizing profit maxima and operational cost minima. We present a formal framework implemented in C++ that processes fixed costs, variable pricing functions, and marginal rates of change to compute precise operational thresholds. Empirical validation using sample operational parameters demonstrates that differential analysis eliminates subjective guess work, offering algorithmic precision for resource allocation and yield optimization. The findings highlight the necessity of embedding non -linear calculus into decision-support software for modern IT systems.', 'verification_status': 'Unverified', 'campus': 'NEUST Peñaranda Campus', 'url': '', 'note': 'THE SEED: The Official Applied Research Journal of NEUST Peñaranda Campus, Volume 1, Issue 1 (2025), Track I: Digital SEEDs (Information Technology). Imported from the supplied PDF.', 'seed_pdf': 'THE_SEED_Vol1_Art10_Quantitative_Optimization_in_Applied_Inf.pdf'}, {'title': 'Applied Quantitative Forecasting Methods in Information Technology: Operational Frameworks and Accuracy Evaluation', 'authors': 'Melgene Lejan J. Bajacan, Cimberlie DG. De Jesus, Danielle P. Madrid, King Zander A. Madulid, John Limuel L. Penson', 'year': '2025', 'course': 'BSIT', 'subject': 'Information Technology', 'research_type': 'Applied Research Paper', 'abstract': 'Quantitative forecasting serves as a critical mechanism for operational planning, capacity evaluation, and risk mitigation across information technology infrastructures and enterprise systems. This study examines the theoretical foundations and practical applications of quantitative methods, specifically focusing on time-series techniques and causal modeling within technical environments. Through a structured evaluation of moving averages, exponential smoothing, and regression analysis, the paper details ho w empirical data can be systematically processed to project system demands, resource allocations, and operational requirements. Furthermore, the investigation incorporates quantitative accuracy metrics, specifically Mean Absolute Deviation (MAD) and Mean Absolute Percentage Error (MAPE), to evaluate model performance and error distribution across dataset projections. The synthesis demonstrates that combining time -series smoothing methods with continuous error tracking enables technology managers to maintain system stability against sudden operational shifts. Ultimately, the study establishes an applied framework for integrating mathematical forecasting models directly into software engineering, network administration, and IT project management workflows.', 'verification_status': 'Unverified', 'campus': 'NEUST Peñaranda Campus', 'url': '', 'note': 'THE SEED: The Official Applied Research Journal of NEUST Peñaranda Campus, Volume 1, Issue 1 (2025), Track I: Digital SEEDs (Information Technology). Imported from the supplied PDF.', 'seed_pdf': 'THE_SEED_Vol1_Art11_Applied_Quantitative_Forecasting_Methods.pdf'}, {'title': 'Application of Quantitative Methods and Decision Tree Modeling in Technical Fault Isolation and IT Project Management', 'authors': 'Karl Joseph A. Austria, Jhon Daniel D. Barlis, Beronica J. Belizario, Jaymee Rose C. Bolisay, Denice Ashley B. De Guzman, and Lexter A. Toribio', 'year': '2025', 'course': 'BSIT', 'subject': 'Information Technology', 'research_type': 'Applied Research Paper', 'abstract': 'In Information Technology (IT) education and applied practice, system development and technical troubleshooting frequently present operational uncertainties, such as hardware interface errors, database corruption, and project scheduling delays. This study evaluates the application of quantitative methods, specifically basic probability, mathematical expectation, and decision tree modeling, to structured decision-making in student-led IT projects. Utilizing a narrative case study approach across multiple app lied IT scenarios, including Arduino hardware prototyping and desktop application development, the research outlines how formal decision frameworks replace intuitive trial-and-error methodologies. Mathematical expectation is applied to evaluate project sch eduling trade-offs based on completion probabilities and prospective delays, while decision trees are implemented to map sequential diagnostic pathways for hardware communication faults and local database connection failures. Results indicate that integrating quantitative risk evaluation into development workflows improves problem resolution efficiency, reduces downtime during debugging, and provides a structured mechanism for contingency planning. The findings demonstrate the utility of embedded mathematical decision frameworks in undergraduate information technology curricula to foster systematic technical risk management.', 'verification_status': 'Unverified', 'campus': 'NEUST Peñaranda Campus', 'url': '', 'note': 'THE SEED: The Official Applied Research Journal of NEUST Peñaranda Campus, Volume 1, Issue 1 (2025), Track I: Digital SEEDs (Information Technology). Imported from the supplied PDF.', 'seed_pdf': 'THE_SEED_Vol1_Art12_Application_of_Quantitative_Methods_and_.pdf'}, {'title': 'A 3D OpenGL Survival Game Using Primitive-Based Modeling and Procedural Animation Rowena Grace Valiente Perez, Cleto Jr. Nolasco Dadap, Rovie Lyn Avila Buan,', 'authors': 'Edwin Valmonte Mallari, Angelica Lalican', 'year': '2025', 'course': 'BSIT', 'subject': 'Information Technology', 'research_type': 'Applied Research Paper', 'abstract': 'This study presents Dragon Chase, a 3D survival and collection game developed in OpenGL with GLUT for CC-103: Data Structures and Algorithm. The project places the player inside a bounded cubic arena populated with trees, dodge obstacles, gems, and health pickups while an AI -controlled dragon actively pursues the character. The system uses primitive geometric shapes, including cubes, spheres, and octahedrons, to create a voxel -inspired visual style that remains simple but functional for student -level graphics development. Core mechanics in clude third-person camera tracking, mouse-look input, player movement and jumping, collision -based health loss, collectible scoring, and timed respawn logic for interactive objects. Procedural animation is implemented through sine-based movement for walking, flying, and item effects, while OpenGL lighting and a 2D HUD provide visual clarity. The project demonstrates how basic graphics primitives, collision checks, and state updates can be combined into a playable real -time application. It also shows the val ue of modular design in building and integrating multiple game systems into a coherent interactive environment.', 'verification_status': 'Unverified', 'campus': 'NEUST Peñaranda Campus', 'url': '', 'note': 'THE SEED: The Official Applied Research Journal of NEUST Peñaranda Campus, Volume 1, Issue 1 (2025), Track I: Digital SEEDs (Information Technology). Imported from the supplied PDF.', 'seed_pdf': 'THE_SEED_Vol1_Art13_A_3D_OpenGL_Survival_Game_Using_Primitiv.pdf'}, {'title': '3D Plaza: Design, Sculpt, and Animate a Colorful Real-Time Interactive Environment Using OpenGL/GLUT', 'authors': 'Jhon Daniel D.C. Barlis, Jomar M. Quijano, Jennylyn G. Tolentino, John Ace B. Tapang', 'year': '2025', 'course': 'BSIT', 'subject': 'Information Technology', 'research_type': 'Applied Research Paper', 'abstract': "This case study documents 3D Plaza, an interactive real -time environment developed by the student team PLAZA VISION with the OpenGL, GLU, and GLUT graphics libraries as a requirement for CC -103, Data Structures and Algorithms. The problem addressed was constructing a coherent, explorable 3D scene from primitive geometry while implementing a responsive, orientation -relative character controller and a functioning lighting model, all within the constraints of a fixed-function graphics pipeline and a limited development schedule. The team's methodology followed a five -stage workflow of planning, design, implementation, testing, and refinement. The resulting scene models a cartoon-styled public plaza containing a rotating Ferris wheel, a swaying carousel, a centr al presentation stage, small shop structures, a perimeter fence, and animated pedestrian characters, navigable through keyboard-driven movement and a mouse-controlled camera. Core technical output includes trigonometric, character-relative movement equations, a gravity-based jump model, a pitch -clamped camera system, and a positional lighting configuration. Testing showed that initial object flicker near geometry-dense regions was resolved through model simplification, after which navigation through the completed scene remained smooth and visually coherent.", 'verification_status': 'Unverified', 'campus': 'NEUST Peñaranda Campus', 'url': '', 'note': 'THE SEED: The Official Applied Research Journal of NEUST Peñaranda Campus, Volume 1, Issue 1 (2025), Track I: Digital SEEDs (Information Technology). Imported from the supplied PDF.', 'seed_pdf': 'THE_SEED_Vol1_Art14_3D_Plaza__Design__Sculpt__and_Animate_a_.pdf'}, {'title': '3D Moving Car: A Real-Time Highway Driving Simulation for Introductory Vehicle Control Learning', 'authors': 'Klyde B. Gedo Cruz, Andrew James P. Garcia, John Meizon P. Abesamis, Harley DC. Aberin, Gerald John V. Madria', 'year': '2025', 'course': 'BSIT', 'subject': 'Information Technology', 'research_type': 'Applied Research Paper', 'abstract': "This case study presents 3D Moving Car, a real -time driving simulation developed by the student team CDZ Knights as a requirement for CC -103, Data Structures and Algorithms. The problem addressed was building an accessible, beginner-friendly environment in which a user could practice basic vehicle control and observe simple driving physics without real -world risk. The team's methodology separated modeling from integration: the car and the highway environment were constructed as independent files and later m erged into a single project, after which movement, collision behavior, and performance were tested and refined across a second and third development session. The resulting simulation places a drivable car on a highway scene populated with trees, street lig hts, buildings, and pedestrians, and exposes keyboard controls for acceleration, braking, steering, horn activation, camera switching, and reset. A dynamic day -and-night lighting cycle changes every ten seconds, and an on -screen heads-up display reports speed, distance traveled, and elapsed time. Two selectable camera modes, a driver -facing view and a bird's -eye view, support both immersive driving and spatial awareness. The team reported no major modeling obstacles and identified color scheming as the primary area for improvement in future iterations.", 'verification_status': 'Unverified', 'campus': 'NEUST Peñaranda Campus', 'url': '', 'note': 'THE SEED: The Official Applied Research Journal of NEUST Peñaranda Campus, Volume 1, Issue 1 (2025), Track I: Digital SEEDs (Information Technology). Imported from the supplied PDF.', 'seed_pdf': 'THE_SEED_Vol1_Art15_3D_Moving_Car__A_Real-Time_Highway_Drivi.pdf'}, {'title': 'Design, Sculpt, and Animate a 3D Model Space: An Interactive Low-Poly House Environment', 'authors': 'John Michael M. Pangilinan, Marialyn G. Cores, Ashley Mae S. Abello, Alfred C. Madria, Mark Kenrick E. Martin', 'year': '2025', 'course': 'BSIT', 'subject': 'Information Technology', 'research_type': 'Applied Research Paper', 'abstract': 'This case study presents the development of an interactive 3D house environment designed as a stylized, low -poly residential setting with first -person, game -like navigation. The project was developed to demonstrate practical application of computer graphic s, interactive programming, and algorithmic concepts within an Information Technology course. The system uses OpenGL and the GLUT library to construct the environment primarily from geometric primitives such as cubes, spheres, and cones. A first -person controller supports keyboard-based movement through W, A, S, and D, while mouse input controls horizontal and vertical camera rotation. The system also implements jumping through vertical velocity and gravity simulation. Interactive elements include front and bedroom doors, a ceiling fan with variable rotation speed, a controllable interior light, and a television light that produces a blue screen-like glow. Door movement uses gradual interpolation toward its target rotation, while the fan uses continuous angle updates based on its current speed. Development involved scene assembly, lighting adjustments, alignment corrections, and performance optimization. The completed system demonstrates functional interaction, animated objects, dynamic lighting, and coordinated 3D scene construction.', 'verification_status': 'Unverified', 'campus': 'NEUST Peñaranda Campus', 'url': '', 'note': 'THE SEED: The Official Applied Research Journal of NEUST Peñaranda Campus, Volume 1, Issue 1 (2025), Track I: Digital SEEDs (Information Technology). Imported from the supplied PDF.', 'seed_pdf': 'THE_SEED_Vol1_Art16_Design__Sculpt__and_Animate_a_3D_Model_S.pdf'}, {'title': 'Development and Needs Assessment of a Smart Reservation and Management System for Jerry De Alicia Hotel and Resort', 'authors': 'Melanie G. Nabunag, John Glenn M. Pacua, Lyza Delos Santos, Kevin Charles P. Platilla', 'year': '2025', 'course': 'BSIT', 'subject': 'Information Technology', 'research_type': 'Applied Research Paper', 'abstract': 'Manual administrative workflows in regional hospitality establishments often lead to operational inefficiencies, record- tracking errors, and customer dissatisfaction. This study presents a comprehensive needs assessment and initial system framework for the Jerry De Alicia Hotel and Resort Smart Reservation and Management System. The primary objective is to transition the facility from manual ledger recording to a centralized digital architecture. Methodologically, a mixed- methods empirical assessment was co nducted from January 29 to January 31, 2025, sampling 20 respondents — comprising resort management, staff, and guests —through structured surveys, semi -structured interviews, and operational document audits. Quantitative findings indicate that 65% of stakeho lders experience critical reservation errors, 60% face double-booking conflicts due to manual entry, and 50% encounter pricing inconsistencies caused by unautomated discount tracking. Key user preferences emphasize a mobile-responsive interface (70%), real-time digital payment integration via GCash (65%), and automated booking confirmations (75%). To address these operational gaps, a centralized web -based platform was designed featuring real -time room inventory management, automated promotional discount handling, and a secure guest notification portal. The initial implementation demonstrates significant improvements in data integrity and reservation workflow efficiency.', 'verification_status': 'Unverified', 'campus': 'NEUST Peñaranda Campus', 'url': '', 'note': 'THE SEED: The Official Applied Research Journal of NEUST Peñaranda Campus, Volume 1, Issue 1 (2025), Track I: Digital SEEDs (Information Technology). Imported from the supplied PDF.', 'seed_pdf': 'THE_SEED_Vol1_Art17_Development_and_Needs_Assessment_of_a_Sm.pdf'}, {'title': 'Optimization and Design of an Integrated Salon Management System: A Needs Assessment and System Specification', 'authors': 'Ginson Kryle Magnaye, Kershelyn Ruby Gay L. Rivera, Hanzy Lei T. Abesamis, Angelica Joy Salazar', 'year': '2025', 'course': 'BSIT', 'subject': 'Information Technology', 'research_type': 'Applied Research Paper', 'abstract': 'Manual record-keeping in small service enterprises often leads to operational inefficiencies, scheduling conflicts, and inventory mismanagement. This study presents a needs assessment conducted from January 29 to January 31, 2025, to evaluate the operation al challenges of a local salon establishment and specify requirements for an integrated Salon Management System. Utilizing a mixed -methods approach comprising surveys, structured interviews, and physical document reviews with key stakeholders ( 𝑛 = 3, representing the property owner and administrative staff), the investigation identified six primary operational bottlenecks: fragmented appointment tracking, manual inventory recording, inconsistent financial logging, inadequate client history tracking, manual shift and commission management, and limited marketing reach. To resolve these ope rational gaps, we propose a modular management framework incorporating automated appointment scheduling, real -time inventory tracking with alert thresholds, digital client profiling with loyalty tracking, multi -channel payment integration, and automated st aff performance analytics. The assessment provides a baseline specification for transitioning small-scale service businesses from manual workflows to a secure, centralized digital architecture.', 'verification_status': 'Unverified', 'campus': 'NEUST Peñaranda Campus', 'url': '', 'note': 'THE SEED: The Official Applied Research Journal of NEUST Peñaranda Campus, Volume 1, Issue 1 (2025), Track I: Digital SEEDs (Information Technology). Imported from the supplied PDF.', 'seed_pdf': 'THE_SEED_Vol1_Art18_Optimization_and_Design_of_an_Integrated.pdf'}, {'title': 'Requirements Assessment and System Design Framework for the Sasy Laundry Hub Management System', 'authors': 'John Lester D. Madrid, Hannah Jane N. Padrones, Elaine H. Pascual, Evangerine A. Bautista', 'year': '2025', 'course': 'BSIT', 'subject': 'Information Technology', 'research_type': 'Applied Research Paper', 'abstract': 'Manual operations in small-scale service enterprises often suffer from record vulnerability and financial tracking errors. This study presents a comprehensive needs assessment conducted for Sasy Laundry Hub between January 28 and January 30, 2025, to estab lish functional specifications for the Sasy Laundry Hub Management System (SLHMS). Utilizing a mixed -methods approach, qualitative interviews and quantitative surveys were administered to a representative sample of ten stakeholders comprising 70% customers, 20% staff, and 10% management. Empirical findings indicate that 30% of operational friction stems from missing customer contact information, while another 30% arises from unrecorded operational expenses such as detergents and utility maintenance. Furthermore, 90% of respondents emphasized the nec essity of real -time data processing. To resolve these operational gaps, an integrated architecture was designed featuring pre-listing of garments, four-stage order status tracking (Pending, In Progress, Ready for Pickup, Claimed), automated inventory monitoring, and role-based financial reporting. The resulting requirements framework serves as a verified architectural foundation for modernizing laundry hub operations.', 'verification_status': 'Unverified', 'campus': 'NEUST Peñaranda Campus', 'url': '', 'note': 'THE SEED: The Official Applied Research Journal of NEUST Peñaranda Campus, Volume 1, Issue 1 (2025), Track I: Digital SEEDs (Information Technology). Imported from the supplied PDF.', 'seed_pdf': 'THE_SEED_Vol1_Art19_Requirements_Assessment_and_System_Desig.pdf'}, {'title': 'Design and Implementation of a Console-Based Property Reservation System with File-Based Persistence and CRUD Operations', 'authors': 'Jomari V. Abesamis, Ysa Sofia E. Zamora, Glezeel F. Villena, Denver C. Gaboy, Emmanuel A. Ortega Jr.', 'year': '2025', 'course': 'BSIT', 'subject': 'Information Technology', 'research_type': 'Applied Research Paper', 'abstract': 'Manual property reservation workflows in small-scale hospitality operations frequently suffer from concurrency errors, duplicate bookings, and inefficient record retrieval. This paper presents the design and implementation of a console - based property reservation system tailored for rental properties in La Union, developed using C++ and permanent text- file persistence. The application implements full Create, Read, Update, Delete, and Search (CRUDS) functionalities alongside domain -specific business logic, in cluding automated cost calculation, age validation, Philippine contact number verification, and dynamic inventory slot management. The system architecture utilizes modular procedural programming, structured text storage via input/output stream operations, and array-based lookup tables for property metadata. Experimental validation demonstrates reliable transaction persistence, effective duplicate booking prevention, and instant record querying without requiring external database dependencies. The project provides a clear instructional foundation for procedural C++ concepts, file stream manipulation, and localized software engineering solutions.', 'verification_status': 'Unverified', 'campus': 'NEUST Peñaranda Campus', 'url': '', 'note': 'THE SEED: The Official Applied Research Journal of NEUST Peñaranda Campus, Volume 1, Issue 1 (2025), Track I: Digital SEEDs (Information Technology). Imported from the supplied PDF.', 'seed_pdf': 'THE_SEED_Vol1_Art1_Design_and_Implementation_of_a_Console-B_1_.pdf'}, {'title': 'EBank CLI: A C++ Text-Based Persistent Digital Banking Simulation Framework Jhan Clarence Maningas, Roselyn Shayne Beltran, Allison Paderes,', 'authors': 'Jobell Bulaclac, Fred Kendrick Constantino', 'year': '2025', 'course': 'BSIT', 'subject': 'Information Technology', 'research_type': 'Applied Research Paper', 'abstract': 'Manual management of banking accounts and transactions can result in recording errors, delayed processing, misplaced records, and difficulty maintaining transaction histories. This paper presents EBank CLI, a C++ console -based digital banking simulation de veloped to demonstrate basic banking operations and data management processes. The application uses a menu-driven command-line interface and text-file persistence to manage user accounts, balances, and transaction histories without requiring an external da tabase. Its core functions include account registration, login, account recovery, deposits, withdrawals, money transfers, transaction history viewing, and account management. CRUDS operations are applied to account records, while input validation is used t o prevent duplicate usernames and emails, invalid withdrawals, and incorrect transaction entries. Separate user folders organize balance and transaction - history files. The system was developed using C++ and Code::Blocks with libraries for file handling, string processing, timing, file-system management, and console interaction. Development and testing demonstrated the practical use of file handling, validation, authentication, and transaction processing in a procedural programming environment. The project also provides a foundation for future migration to a relational database and graphical interface.', 'verification_status': 'Unverified', 'campus': 'NEUST Peñaranda Campus', 'url': '', 'note': 'THE SEED: The Official Applied Research Journal of NEUST Peñaranda Campus, Volume 1, Issue 1 (2025), Track I: Digital SEEDs (Information Technology). Imported from the supplied PDF.', 'seed_pdf': 'THE_SEED_Vol1_Art2_EBank_CLI__A_C___Text-Based_Persistent_D.pdf'}, {'title': 'Order Management System with CRUD Functions Hanz Carlo Abesamis, April De Guzman, Samantha Madrid,', 'authors': 'John Vergel Bote, Carlo Masilang', 'year': '2025', 'course': 'BSIT', 'subject': 'Information Technology', 'research_type': 'Applied Research Paper', 'abstract': 'Small businesses and food establishments may experience difficulties when customer orders are recorded manually or through loosely organized files. These practices can result in misplaced records, slow processing, and difficulties in updating or removing existing information. This study presents an Order Management System with CRUD Functions developed by Group 3 for CC -102 Computer Programming 2 using C++. The system applies fundamental programming concepts, including parallel arrays, functions, loops, input validation, role-based menus, and file handling. Customer accounts and order records are stored persistently in plain-text files, allowing information to be restored when the program is reopened. The system implements Create, Read, Update, Delete, and Se arch operations for order management. Customers can register, log in, create orders, display their own records, modify orders, and delete orders, while staff members have extended administrative functions for managing customer accounts and orders. Development involved incremental function implementation, validation testing, integration testing, and debugging. The completed system demonstrates how fundamental C++ programming concepts can be combined into a functional console-based information system while providing practical experience in data organization, persistence, input validation, and access control.', 'verification_status': 'Unverified', 'campus': 'NEUST Peñaranda Campus', 'url': '', 'note': 'THE SEED: The Official Applied Research Journal of NEUST Peñaranda Campus, Volume 1, Issue 1 (2025), Track I: Digital SEEDs (Information Technology). Imported from the supplied PDF.', 'seed_pdf': 'THE_SEED_Vol1_Art3_Order_Management_System_with_CRUD_Functi.pdf'}, {'title': 'Karenderya Inventory Management System with CRUD Functions: A Console-Based C++ Case Study', 'authors': 'John Joshua A. Elbumbuena, Daren Del Rosario, John Mark Mabalay', 'year': '2025', 'course': 'BSIT', 'subject': 'Information Technology', 'research_type': 'Applied Research Paper', 'abstract': 'Small food businesses such as karenderyas, canteens, and food stalls commonly rely on manual methods for recording sales and monitoring products. Paper -based records can result in missing entries, incorrect stock or sales counts, duplicate records, and del ays in monitoring transactions. This study presents a console -based Karenderya Inventory Management System developed in C++ to provide a more organized approach to sales and inventory record management. The system implements the four basic CRUD operations: Create, Read, Update, and Delete. It uses a predefined food-product array for menu information, automatically records the current transaction date, calculates the total amount from product price and quantity, and stores transaction records in a text file named sales.txt. The main functions include addSale(), displaySales(), editSale(), and a delete operation that uses a temporary file to reconstruct the updated records. The system was developed using C++ through Dev -C++ or Code::Blocks with a console -based interface. Based on the project evaluation, the system provides organized sales records, automatic computation, and simpler transaction management compared with manual recording. The project demonstrates how fundamental programming concepts can be applied to address a practical small-business management problem.', 'verification_status': 'Unverified', 'campus': 'NEUST Peñaranda Campus', 'url': '', 'note': 'THE SEED: The Official Applied Research Journal of NEUST Peñaranda Campus, Volume 1, Issue 1 (2025), Track I: Digital SEEDs (Information Technology). Imported from the supplied PDF.', 'seed_pdf': 'THE_SEED_Vol1_Art4_Karenderya_Inventory_Management_System_w.pdf'}, {'title': 'Academic Management System with CRUD Functions Using C++ and Text-File Storage', 'authors': 'Princess Ariean P. Gaboy, April Joy Legaspi, Nicole Madria, Maricris O. Torres, Danica Joy Rodriguez', 'year': '2025', 'course': 'BSIT', 'subject': 'Information Technology', 'research_type': 'Applied Research Paper', 'abstract': 'Educational institutions require organized methods for maintaining student academic records, particularly when information includes personal details, subjects, grades, and computed averages. Manual record management through paper documents, notebooks, or spreadsheets can make searching, updating, and maintaining records more difficult and may result in duplicated, disorganized, or lost information. This project presents an Academic Management System with CRUD Functions developed in C++ as a computerized app roach to managing student academic records. The system uses text files as persistent storage and applies fundamental programming concepts including file handling, arrays, functions, loops, conditional statements, string manipulation, and input validation. Its major functions include secure login, student registration, automatic student ID generation, student categorization, creation and retrieval of records, record modification, deletion and recovery, searching, and automatic computation of average grades. A color-coded console interface was also implemented to improve menu readability. The resulting application provides a functional and organized method for storing and managing student information while demonstrating the practical application of intermediate C++ programming concepts. The project serves as a student -developed case study of how basic programming structures can be combined to create a functional academic record management application.', 'verification_status': 'Unverified', 'campus': 'NEUST Peñaranda Campus', 'url': '', 'note': 'THE SEED: The Official Applied Research Journal of NEUST Peñaranda Campus, Volume 1, Issue 1 (2025), Track I: Digital SEEDs (Information Technology). Imported from the supplied PDF.', 'seed_pdf': 'THE_SEED_Vol1_Art5_Academic_Management_System_with_CRUD_Fun.pdf'}, {'title': 'Design and Implementation of an Animated Low-Poly 3D Countryside Barn Using C++ and OpenGL Reign Castillo Mariano, Elizer Padilla Geronimo, Christian Erice Capile Evariso,', 'authors': 'Arlan James Barlis Esteban, Gunther Guial Germino', 'year': '2025', 'course': 'BSIT', 'subject': 'Information Technology', 'research_type': 'Applied Research Paper', 'abstract': 'This study presents the design and implementation of an interactive low -poly 3D countryside barn environment developed using C++, OpenGL, and GLUT. The project was created as a practical application of computer graphics, mathematical modeling, real-time rendering, and algorithmic animation in an educational setting. The system represents a lightweight farm environment consisting of a barn, rolling procedural terrain, trees, fences, animals, a sky dome, stars, and dynamic sun and moon lighting. A modular mod eling approach was used to construct scene objects from basic geometric primitives such as cubes, cylinders, cones, and spheres. The application implements first -person camera navigation through W, A, S, D controls and mouse -based camera rotation, while a ground-following mechanism maintains the camera at a fixed height above the terrain. A 120 -second day/night cycle dynamically modifies the light position, color, intensity, and sky appearance. Additional animations include tree swaying and a low-poly pig walking in place. The resulting system demonstrates that a relatively simple OpenGL implementation can produce an interactive and computationally lightweight 3D environment suitable for learning real-time graphics concepts.', 'verification_status': 'Unverified', 'campus': 'NEUST Peñaranda Campus', 'url': '', 'note': 'THE SEED: The Official Applied Research Journal of NEUST Peñaranda Campus, Volume 1, Issue 1 (2025), Track I: Digital SEEDs (Information Technology). Imported from the supplied PDF.', 'seed_pdf': 'THE_SEED_Vol1_Art6_Design_and_Implementation_of_an_Animated.pdf'}, {'title': 'A Console-Based Job Application System Using C++ with File Handling Integration', 'authors': 'Anne Laley Obenita, Dan Mark E. Abarquez, Angelo Jerfferson H. Alarilla, Trixie Joice G. Madrid, Cyron June C. Martinez', 'year': '2025', 'course': 'BSIT', 'subject': 'Information Technology', 'research_type': 'Applied Research Paper', 'abstract': 'This study presents the design and implementation of a console -based Job Application System developed in C++ to address inefficiencies in manual job application processes. Traditional paper -based methods often result in misplaced records, duplicate files, and difficulty in tracking applicant status. The proposed system integrates CRUDS (Create, Read, Update, Delete, Search) operations and file handling through the fstream library to store applicant data in text files, ensuring persistence beyond program execution. Applicants can register, log in, update their information, and monitor application status, while administrators can view, approve, or reject applications. The sy stem workflow was structured to include secure login mechanisms, validation routines, and a colored interface for improved usability. Development challenges included handling invalid inputs, managing loops and conditions, and ensuring proper data saving. Results demonstrate that the system provides a more organized, efficient, and reliable approach to managing job applications. Future enhancements may include graphical user interfaces, database integration, and password encryption to strengthen usability and security.', 'verification_status': 'Unverified', 'campus': 'NEUST Peñaranda Campus', 'url': '', 'note': 'THE SEED: The Official Applied Research Journal of NEUST Peñaranda Campus, Volume 1, Issue 1 (2025), Track I: Digital SEEDs (Information Technology). Imported from the supplied PDF.', 'seed_pdf': 'THE_SEED_Vol1_Art7_A_Console-Based_Job_Application_System_U.pdf'}, {'title': 'Applied Deterministic Optimization in Information Technology: A Case Study on Linear Programming Formulation and Simplex Implementation for Resource Allocation', 'authors': 'Gerald John V. Madria, Jomar M. Quijano, Harley DC. Aberin, John Ace B. Tapang, Jose Mari Allaine Dela Cruz, Vincent Mar M. Bote, and Rafael Charles V. Lasaca', 'year': '2025', 'course': 'BSIT', 'subject': 'Information Technology', 'research_type': 'Applied Research Paper', 'abstract': 'In contemporary software engineering and IT project management, optimizing operational efficiency under strict technical and resource constraints is critical. This study examines the practical implementation of Linear Programming (LP) and the Simplex algor ithm to address deterministic resource allocation challenges within IT operational environments. Using a structured quantitative framework, we formulate objective functions, decision variables, and linear inequalities to model hardware capacity selection, system resource distribution, and project scheduling. We evaluate two primary analytical methods: two -dimensional graphical optimization across convex feasible regions and multi-variable matrix operations utilizing the iterative Simplex procedure. Furtherm ore, we address special computational scenarios, including primal and dual degeneracy, non -convergent unboundedness, and alternative optimal solutions. The mathematical formulations were validated through procedural C++ algorithmic implementations designed to optimize operational throughput. The findings demonstrate that systematic mathematical optimization reduces project uncertainty, mitigates system failure risks, and establishes objective, data -driven decision-making in technical workflows.', 'verification_status': 'Unverified', 'campus': 'NEUST Peñaranda Campus', 'url': '', 'note': 'THE SEED: The Official Applied Research Journal of NEUST Peñaranda Campus, Volume 1, Issue 1 (2025), Track I: Digital SEEDs (Information Technology). Imported from the supplied PDF.', 'seed_pdf': 'THE_SEED_Vol1_Art8_Applied_Deterministic_Optimization_in_In.pdf'}, {'title': 'Algorithmic Optimization of Logistics and Resource Allocation: An Applied Study on Transportation Models and the Hungarian Method', 'authors': 'Andrea B. Gaboy, Jennylyn G. Tolentino, Lorraine B. Geronimo, Carl Mathew R. Dizon, Raymond T. Dela Cruz, Shanyl E. Alfonso, and John Meizon P. Abesamis', 'year': '2025', 'course': 'BSIT', 'subject': 'Information Technology', 'research_type': 'Applied Research Paper', 'abstract': 'Logistics management and resource allocation present fundamental challenges in supply chain operations and software engineering. This paper presents an applied evaluation and computational implementation of transportation models and the Hungarian Algorithm for optimal resource distribution. We formulate linear programming frameworks to model supply-demand networks and one -to-one assignment constraints. The implementation framework processes cost matrices using systematic matrix reduction, dummy variable ins ertion for unbalanced conditions, and iterative zero - opportunity cost line testing. We evaluated classic distribution approaches—including the North-West Corner Method and the Least Cost Method—alongside the five-stage Hungarian optimization routine. Operational results confirm that global optimization routines systematically outperform manual allocations, achieving deterministic cost minimization while eliminating systemic trade-off errors. The computational workflow translates complex operational constraints into deterministic execution steps suitable for automated decision-support software in IT environments.', 'verification_status': 'Unverified', 'campus': 'NEUST Peñaranda Campus', 'url': '', 'note': 'THE SEED: The Official Applied Research Journal of NEUST Peñaranda Campus, Volume 1, Issue 1 (2025), Track I: Digital SEEDs (Information Technology). Imported from the supplied PDF.', 'seed_pdf': 'THE_SEED_Vol1_Art9_Algorithmic_Optimization_of_Logistics_an.pdf'}]
    seed_pdf_dir = BACKEND_DIR / "seed_research_pdfs"
    seed_pdf_dir.mkdir(parents=True, exist_ok=True)
    with SessionLocal() as db:
        # Add existing starter records only when their titles are not already present.
        for record in starter_research:
            existing = db.scalar(select(Research).where(Research.title == record["title"]))
            if not existing:
                db.add(Research(**record))
        db.flush()
        # Import THE SEED PDFs as BSIT records; never overwrite existing records.
        for record in the_seed_research:
            existing = db.scalar(select(Research).where(Research.title == record["title"]))
            if existing:
                # Attach the supplied PDF only if this record does not already have one.
                if not existing.pdf_filename:
                    source = seed_pdf_dir / record["seed_pdf"]
                    if source.is_file():
                        stored = f"the-seed-{uuid.uuid5(uuid.NAMESPACE_URL, record['title']).hex}.pdf"
                        target = RESEARCH_PDF_DIR / stored
                        if not target.exists():
                            shutil.copy2(source, target)
                        existing.pdf_filename = stored
                continue
            source = seed_pdf_dir / record["seed_pdf"]
            pdf_filename = None
            if source.is_file():
                pdf_filename = f"the-seed-{uuid.uuid5(uuid.NAMESPACE_URL, record['title']).hex}.pdf"
                target = RESEARCH_PDF_DIR / pdf_filename
                if not target.exists():
                    shutil.copy2(source, target)
            values = {key: value for key, value in record.items() if key != "seed_pdf"}
            values["pdf_filename"] = pdf_filename
            db.add(Research(**values))
        db.commit()

# =========================================================
# HOME AND HEALTH
# =========================================================

@app.get("/")
def root():
    return {
        "name": "LibTrack API",
        "status": "running",
        "docs": "/docs",
    }

@app.get("/health")
def health():
    return {
        "status": "ok",
        "timestamp": datetime.utcnow().isoformat(),
    }


@app.get("/settings/weekend-notice")
def get_weekend_notice_settings(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rows = {item.key: item.value for item in db.scalars(
        select(SystemSetting).where(SystemSetting.key.in_([
            "weekend_notice_enabled", "weekend_notice_time", "weekend_notice_message"
        ]))
    ).all()}
    return {
        "enabled": rows.get("weekend_notice_enabled", "true").lower() == "true",
        "time": rows.get("weekend_notice_time", "07:00"),
        "message": rows.get("weekend_notice_message", "Book borrowing is unavailable on Saturdays and Sundays. Please visit the library during regular operating days (Monday-Friday)."),
    }


@app.put("/settings/weekend-notice")
def update_weekend_notice_settings(
    payload: WeekendNoticeUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    values = {
        "weekend_notice_enabled": "true" if payload.enabled else "false",
        "weekend_notice_time": payload.time,
        "weekend_notice_message": payload.message.strip(),
    }
    for key, value in values.items():
        item = db.get(SystemSetting, key)
        if item:
            item.value = value
        else:
            db.add(SystemSetting(key=key, value=value))
    db.commit()
    return {"enabled": payload.enabled, "time": payload.time, "message": payload.message.strip()}


DEFAULT_LIBRARY_SCHEDULE = {
    "Monday": {"closed": False, "open": "12:00", "close": "22:00"},
    "Tuesday": {"closed": False, "open": "12:00", "close": "22:00"},
    "Wednesday": {"closed": False, "open": "12:00", "close": "22:00"},
    "Thursday": {"closed": False, "open": "12:00", "close": "22:00"},
    "Friday": {"closed": False, "open": "12:00", "close": "22:00"},
    "Saturday": {"closed": True, "open": "08:00", "close": "12:00"},
    "Sunday": {"closed": True, "open": "08:00", "close": "12:00"},
}

@app.get("/settings/borrowing-schedule")
def get_borrowing_schedule(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    item = db.get(SystemSetting, "borrowing_schedule")
    if not item or not item.value:
        return {"schedule": DEFAULT_BORROWING_SCHEDULE}
    try:
        saved = json.loads(item.value)
        if not isinstance(saved, dict):
            return {"schedule": DEFAULT_BORROWING_SCHEDULE}
        return {"schedule": {**DEFAULT_BORROWING_SCHEDULE, **saved}}
    except (TypeError, ValueError):
        return {"schedule": DEFAULT_BORROWING_SCHEDULE}


@app.put("/settings/borrowing-schedule")
def update_borrowing_schedule(
    payload: BorrowingScheduleUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", payload.open_time):
        raise HTTPException(status_code=422, detail="Invalid borrowing opening time.")
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", payload.close_time):
        raise HTTPException(status_code=422, detail="Invalid borrowing closing time.")
    if payload.enabled and payload.close_time <= payload.open_time:
        raise HTTPException(status_code=422, detail="Borrowing closing time must be later than opening time.")
    if any(day not in VALID_BORROWING_DAYS for day in payload.days):
        raise HTTPException(status_code=422, detail="Invalid borrowing day selected.")
    clean = {
        "enabled": payload.enabled,
        "days": [day for day in VALID_BORROWING_DAYS if day in payload.days],
        "open_time": payload.open_time,
        "close_time": payload.close_time,
        "message": payload.message.strip() or DEFAULT_BORROWING_SCHEDULE["message"],
    }
    item = db.get(SystemSetting, "borrowing_schedule")
    encoded = json.dumps(clean, separators=(",", ":"))
    if item:
        item.value = encoded
    else:
        db.add(SystemSetting(key="borrowing_schedule", value=encoded))
    db.commit()
    return {"schedule": clean}


def enforce_borrowing_schedule(db: Session):
    item = db.get(SystemSetting, "borrowing_schedule")
    schedule = DEFAULT_BORROWING_SCHEDULE.copy()
    if item and item.value:
        try:
            saved = json.loads(item.value)
            if isinstance(saved, dict):
                schedule.update(saved)
        except (TypeError, ValueError):
            pass
    now = datetime.now(ZoneInfo("Asia/Manila"))
    day_name = now.strftime("%A")
    current_time = now.strftime("%H:%M")
    if (
        not schedule.get("enabled", True)
        or day_name not in schedule.get("days", DEFAULT_BORROWING_SCHEDULE["days"])
        or current_time < str(schedule.get("open_time", "08:00"))
        or current_time >= str(schedule.get("close_time", "17:00"))
    ):
        raise HTTPException(
            status_code=403,
            detail=str(schedule.get("message") or DEFAULT_BORROWING_SCHEDULE["message"]),
        )


@app.get("/settings/library-schedule")
def get_library_schedule(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    item = db.get(SystemSetting, "library_schedule")
    if not item or not item.value:
        return {"schedule": DEFAULT_LIBRARY_SCHEDULE}
    try:
        saved = json.loads(item.value)
        return {"schedule": saved if isinstance(saved, dict) else DEFAULT_LIBRARY_SCHEDULE}
    except (TypeError, ValueError):
        return {"schedule": DEFAULT_LIBRARY_SCHEDULE}

@app.put("/settings/library-schedule")
def update_library_schedule(
    payload: LibraryScheduleUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    days = list(DEFAULT_LIBRARY_SCHEDULE.keys())
    clean = {}
    for day in days:
        value = payload.schedule.get(day, DEFAULT_LIBRARY_SCHEDULE[day])
        is_closed = bool(value.get("closed", False))
        opening = str(value.get("open", "08:00"))
        closing = str(value.get("close", "17:00"))
        for label, clock in (("opening", opening), ("closing", closing)):
            if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", clock):
                raise HTTPException(status_code=422, detail=f"Invalid {label} time for {day}.")
        if not is_closed and closing <= opening:
            raise HTTPException(status_code=422, detail=f"Closing time must be later than opening time for {day}.")
        clean[day] = {"closed": is_closed, "open": opening, "close": closing}
    item = db.get(SystemSetting, "library_schedule")
    encoded = json.dumps(clean, separators=(",", ":"))
    if item:
        item.value = encoded
    else:
        db.add(SystemSetting(key="library_schedule", value=encoded))
    db.commit()
    return {"schedule": clean}

# =========================================================
# STUDENT REGISTRATION AND LOGIN
# =========================================================

@app.post("/auth/register", status_code=201)
def register_student(
    payload: RegisterRequest,
    db: Session = Depends(get_db),
):
    full_name = clean_required(payload.full_name, "Full name")
    student_id = clean_required(payload.student_id, "Student ID")
    course = clean_required(payload.course, "Course")
    year = clean_required(payload.year, "Year")
    section = clean_required(payload.section, "Section")
    email = normalize_email(payload.email)
    username = clean_required(payload.username, "Username").lower()

    if any(character.isspace() for character in username):
        raise HTTPException(
            status_code=422,
            detail="Username cannot contain spaces.",
        )

    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(
            status_code=409,
            detail="Email already registered.",
        )

    if db.scalar(
        select(User).where(User.student_id == student_id)
    ):
        raise HTTPException(
            status_code=409,
            detail="Student ID already registered.",
        )

    if db.scalar(
        select(User).where(User.username == username)
    ):
        raise HTTPException(
            status_code=409,
            detail="Username already taken.",
        )

    user = User(
        full_name=full_name,
        student_id=student_id,
        course=course,
        year=year,
        section=section,
        email=email,
        username=username,
        role="student",
        active=True,
        password_hash=hash_password(payload.password),
    )

    try:
        db.add(user)
        db.commit()
        db.refresh(user)
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail=(
                "Registration could not be completed. "
                "Check whether your details already exist."
            ),
        )

    if payload.profile_photo_data_url:
        try:
            save_profile_photo(user, payload.profile_photo_data_url)
            db.commit()
            db.refresh(user)
        except Exception:
            db.rollback()
            # Account creation remains successful even if optional photo upload fails.
    return {
        "message": "Student account created successfully.",
        **user_out(user),
    }

@app.post("/auth/profile-photo")
def upload_my_profile_photo(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    content_type = (file.content_type or "").lower()
    if content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(status_code=415, detail="Upload a JPG, PNG, or WEBP image.")
    contents = file.file.read(3 * 1024 * 1024 + 1)
    if not contents or len(contents) > 3 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Profile photo must be 3 MB or smaller.")
    import base64
    encoded = base64.b64encode(contents).decode("ascii")
    url = save_profile_photo(user, f"data:{content_type};base64,{encoded}")
    db.commit()
    db.refresh(user)
    return {"profile_photo_url": url}

@app.post("/auth/register-faculty", status_code=201)
def register_faculty(
    payload: FacultyRegisterRequest,
    db: Session = Depends(get_db),
):
    full_name = clean_required(payload.full_name, "Full name")
    email = normalize_email(payload.email)
    username = clean_required(payload.username, "Username").lower()
    if any(character.isspace() for character in username):
        raise HTTPException(status_code=422, detail="Username cannot contain spaces.")
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(status_code=409, detail="Email already registered.")
    if db.scalar(select(User).where(User.username == username)):
        raise HTTPException(status_code=409, detail="Username already taken.")
    user = User(
        full_name=full_name, email=email, username=username,
        role="faculty", active=True, password_hash=hash_password(payload.password),
    )
    try:
        db.add(user)
        db.commit()
        db.refresh(user)
    except Exception:
        db.rollback()
        raise HTTPException(status_code=409, detail="Faculty registration could not be completed. Check whether your details already exist.")
    if payload.profile_photo_data_url:
        try:
            save_profile_photo(user, payload.profile_photo_data_url)
            db.commit()
            db.refresh(user)
        except Exception:
            db.rollback()
    return {"message": "Faculty account created successfully.", **user_out(user)}


@app.post("/auth/login")
def login(
    payload: LoginRequest,
    db: Session = Depends(get_db),
):
    email = normalize_email(payload.email)

    user = db.scalar(
        select(User).where(User.email == email)
    )

    if (
        not user
        or not user.password_hash
        or not verify_password(
            payload.password, user.password_hash
        )
        or not user.active
    ):
        raise HTTPException(
            status_code=401,
            detail="Incorrect email or password.",
        )

    token_id = secrets.token_urlsafe(24)
    access_token = create_access_token(user, token_id)

    db.add(
        LoginSession(
            token_id=token_id,
            user_id=user.id,
            created_at=datetime.utcnow(),
            last_seen=datetime.utcnow(),
        )
    )
    db.commit()

    return {
        "access_token": access_token,
        "token_type": "bearer",
        "expires_in": ACCESS_TOKEN_MINUTES * 60,
        "id": user.id,
        "role": user.role,
        "full_name": user.full_name,
        "email": user.email,
        "student_id": user.student_id,
        "username": user.username,
        "course": user.course,
        "year": user.year,
        "section": user.section,
        "profile_photo_url": user.profile_photo_url,
    }

@app.get("/auth/me")
def my_account(
    user: User = Depends(get_current_user),
):
    return user_out(user)

@app.post("/auth/change-password")
def change_password(
    payload: ChangePasswordRequest,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if credentials is None:
        raise HTTPException(status_code=401, detail="Please log in.")

    if not user.password_hash or not verify_password(
        payload.current_password, user.password_hash
    ):
        raise HTTPException(status_code=400, detail="Current password is incorrect.")

    if payload.current_password == payload.new_password:
        raise HTTPException(
            status_code=422,
            detail="Choose a password different from your current password.",
        )

    try:
        claims = jwt.decode(
            credentials.credentials,
            SECRET_KEY,
            algorithms=[ALGORITHM],
        )
        current_token_id = claims.get("jti")
    except InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid login session.")

    if not current_token_id:
        raise HTTPException(status_code=401, detail="Login session ID is missing.")

    current_session = db.scalar(
        select(LoginSession).where(
            LoginSession.token_id == current_token_id,
            LoginSession.user_id == user.id,
            LoginSession.logged_out_at.is_(None),
        )
    )
    if current_session is None:
        raise HTTPException(status_code=401, detail="Login session is no longer active.")

    user.password_hash = hash_password(payload.new_password)

    # Sign out the user's other devices, but keep this current session active.
    other_sessions = db.scalars(
        select(LoginSession).where(
            LoginSession.user_id == user.id,
            LoginSession.logged_out_at.is_(None),
            LoginSession.token_id != current_token_id,
        )
    ).all()
    signed_out_at = datetime.utcnow()
    for session in other_sessions:
        session.logged_out_at = signed_out_at

    db.commit()
    return {
        "message": "Password changed successfully.",
        "other_sessions_signed_out": len(other_sessions),
    }


@app.post("/auth/heartbeat")
def session_heartbeat(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(
        bearer_scheme
    ),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if credentials is None:
        raise HTTPException(
            status_code=401,
            detail="Please log in.",
        )

    try:
        claims = jwt.decode(
            credentials.credentials,
            SECRET_KEY,
            algorithms=[ALGORITHM],
        )
        token_id = claims.get("jti")
    except InvalidTokenError:
        raise HTTPException(
            status_code=401,
            detail="Invalid token.",
        )

    if not token_id:
        raise HTTPException(
            status_code=401,
            detail="Session ID is missing.",
        )

    session = db.scalar(
        select(LoginSession).where(
            LoginSession.token_id == token_id,
            LoginSession.user_id == user.id,
            LoginSession.logged_out_at.is_(None),
        )
    )

    if session is None:
        raise HTTPException(
            status_code=401,
            detail="Login session is no longer active.",
        )

    session.last_seen = datetime.utcnow()
    db.commit()

    return {
        "status": "ok",
        "last_seen": session.last_seen.isoformat(),
    }

@app.post("/auth/logout")
def logout(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(
        bearer_scheme
    ),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if credentials is not None:
        try:
            claims = jwt.decode(
                credentials.credentials,
                SECRET_KEY,
                algorithms=[ALGORITHM],
            )
            token_id = claims.get("jti")
        except InvalidTokenError:
            token_id = None

        if token_id:
            session = db.scalar(
                select(LoginSession).where(
                    LoginSession.token_id == token_id,
                    LoginSession.user_id == user.id,
                )
            )

            if session is not None:
                session.logged_out_at = datetime.utcnow()
                db.commit()

    return {"message": "Logged out successfully."}
# =========================================================
# ADMIN SESSION MONITORING
# =========================================================

@app.get("/admin/sessions")
def list_logged_in_sessions(
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    cutoff = datetime.utcnow() - timedelta(seconds=90)

    rows = db.execute(
        select(LoginSession, User)
        .join(User, User.id == LoginSession.user_id)
        .where(
            LoginSession.logged_out_at.is_(None),
            LoginSession.last_seen >= cutoff,
            User.active.is_(True),
        )
        .order_by(LoginSession.last_seen.desc())
    ).all()

    return [
        {
            "user_id": user.id,
            "full_name": user.full_name,
            "email": user.email,
            "role": user.role,
            "status": "Online",
            "login_at": session.created_at.isoformat(),
            "last_seen": session.last_seen.isoformat(),
        }
        for session, user in rows
    ]

# =========================================================
# USER MANAGEMENT (ADMIN ONLY)
# =========================================================

@app.post("/users", status_code=201)
def create_user(
    payload: UserCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    full_name = clean_required(payload.full_name, "Full name")
    email = normalize_email(payload.email)

    if payload.role not in ("student", "admin"):
        raise HTTPException(
            status_code=422,
            detail="Role must be student or admin.",
        )

    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(
            status_code=409,
            detail="Email already exists.",
        )

    user = User(
        full_name=full_name,
        email=email,
        role=payload.role,
        active=True,
        password_hash=hash_password(payload.password),
    )

    db.add(user)
    db.commit()
    db.refresh(user)

    return user_out(user)

@app.get("/users")
def list_users(
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    users = db.scalars(
        select(User).order_by(User.full_name)
    ).all()

    return [user_out(user) for user in users]

@app.patch("/users/{user_id}")
def update_user(
    user_id: int,
    payload: UserUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Update account details, including School ID and Course, without recreating the account."""
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="User account not found.")

    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=400, detail="No changes provided.")

    if "role" in changes:
        if changes["role"] not in ("student", "admin"):
            raise HTTPException(status_code=422, detail="Role must be student or admin.")
        if target.id == admin.id and changes["role"] != "admin":
            raise HTTPException(status_code=400, detail="You cannot remove your own admin role.")

    if "full_name" in changes and changes["full_name"] is not None:
        changes["full_name"] = clean_required(changes["full_name"], "Full name")

    if "student_id" in changes and changes["student_id"] is not None:
        changes["student_id"] = clean_required(changes["student_id"], "School ID")
        duplicate = db.scalar(select(User).where(
            User.student_id == changes["student_id"], User.id != user_id
        ))
        if duplicate:
            raise HTTPException(status_code=409, detail="School ID already belongs to another account.")

    if "course" in changes and changes["course"] is not None:
        changes["course"] = clean_required(changes["course"], "Course")

    if "year" in changes and changes["year"] is not None:
        changes["year"] = clean_required(changes["year"], "Year")

    if "section" in changes and changes["section"] is not None:
        changes["section"] = clean_required(changes["section"], "Section")

    if "email" in changes and changes["email"] is not None:
        changes["email"] = normalize_email(changes["email"])
        duplicate = db.scalar(select(User).where(
            User.email == changes["email"], User.id != user_id
        ))
        if duplicate:
            raise HTTPException(status_code=409, detail="Email already belongs to another account.")

    if "username" in changes and changes["username"] is not None:
        changes["username"] = clean_required(changes["username"], "Username").lower()
        if any(character.isspace() for character in changes["username"]):
            raise HTTPException(status_code=422, detail="Username cannot contain spaces.")
        duplicate = db.scalar(select(User).where(
            User.username == changes["username"], User.id != user_id
        ))
        if duplicate:
            raise HTTPException(status_code=409, detail="Username already belongs to another account.")

    for field, value in changes.items():
        setattr(target, field, value)

    try:
        db.commit()
        db.refresh(target)
    except Exception:
        db.rollback()
        raise HTTPException(status_code=409, detail="Account update failed. Check for duplicate account details.")

    return user_out(target)

@app.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    if user_id == admin.id:
        raise HTTPException(
            status_code=400,
            detail="You cannot delete your own account.",
        )

    target = db.get(User, user_id)

    if target is None:
        raise HTTPException(
            status_code=404,
            detail="User account not found.",
        )

    history_id = db.scalar(
        select(Borrowing.id)
        .where(Borrowing.user_id == user_id)
        .limit(1)
    )

    if history_id is not None:
        raise HTTPException(
            status_code=409,
            detail="Cannot delete an account with borrowing history.",
        )

    try:
        db.query(LoginSession).filter(
            LoginSession.user_id == user_id
        ).delete(synchronize_session=False)

        db.delete(target)
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail="Account deletion failed.",
        )

    return {
        "message": "User account deleted successfully.",
        "id": user_id,
    }

# =========================================================
# E-BOOK LIBRARY (LOCAL PDF UPLOAD; PUBLIC READ, ADMIN UPLOAD)
# =========================================================



def public_cover_url(key: Optional[str]) -> Optional[str]:
    if not key:
        return None
    safe_key = Path(key).name
    if supabase:
        try:
            return supabase.storage.from_(BUCKET_COVERS).get_public_url(key)
        except Exception:
            return None
    return f"/uploads/book_covers/{safe_key}"


def validate_cover_upload(file: UploadFile, contents: bytes):
    allowed = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
    }
    content_type = (file.content_type or "").lower()
    if content_type not in allowed:
        raise HTTPException(status_code=415, detail="Cover must be JPG, PNG, or WEBP.")
    if not contents or len(contents) > MAX_BOOK_COVER_BYTES:
        raise HTTPException(status_code=413, detail="Cover is empty or exceeds the 5 MB limit.")
    signatures = {
        "image/jpeg": contents.startswith(b"\xff\xd8\xff"),
        "image/png": contents.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/webp": len(contents) >= 12 and contents[:4] == b"RIFF" and contents[8:12] == b"WEBP",
    }
    if not signatures[content_type]:
        raise HTTPException(status_code=415, detail="The selected file is not a valid image.")
    return allowed[content_type]



# =========================================================
# COURSE COLLECTION COVERS (RESEARCH + E-BOOK LIBRARY)
# =========================================================

def normalize_collection_code(course_code: str) -> str:
    code = re.sub(r"\s+", " ", (course_code or "").strip()).upper()
    if not code or not re.fullmatch(r"[A-Z0-9][A-Z0-9 _-]{0,39}", code):
        raise HTTPException(status_code=400, detail="Invalid course code.")
    return code


def collection_cover_prefix(collection: str) -> str:
    return f"collection-covers/{collection}/"


def list_collection_cover_urls(collection: str):
    prefix = collection_cover_prefix(collection)
    covers = {}
    if supabase:
        try:
            keys = storage_walk(BUCKET_COVERS, prefix.rstrip("/"))
        except Exception as exc:
            raise HTTPException(status_code=503, detail="Could not load collection photos from storage.") from exc
        for key in keys:
            filename = Path(key).name
            code = Path(filename).stem.upper()
            if code:
                covers[code] = public_cover_url(key)
    else:
        for path in BOOK_COVER_DIR.glob(f"collection-{collection}-*.*"):
            code = path.stem[len(f"collection-{collection}-"):].upper()
            if code:
                covers[code] = f"/uploads/book_covers/{path.name}"
    return covers


async def save_collection_cover(collection: str, course_code: str, file: UploadFile, admin: User):
    code = normalize_collection_code(course_code)
    contents = await file.read()
    extension = validate_cover_upload(file, contents)
    filename = f"{code}{extension}"
    content_type = file.content_type or "image/jpeg"
    if supabase:
        key = f"{collection_cover_prefix(collection)}{filename}"
        try:
            storage_upload(BUCKET_COVERS, key, contents, content_type)
            cover_url = public_cover_url(key)
        except Exception as exc:
            raise HTTPException(status_code=500, detail="Could not save the collection photo to storage.") from exc
    else:
        # Keep one active extension per course so replacing a photo cannot leave stale variants.
        for old_extension in (".jpg", ".png", ".webp"):
            (BOOK_COVER_DIR / f"collection-{collection}-{code}{old_extension}").unlink(missing_ok=True)
        target = BOOK_COVER_DIR / f"collection-{collection}-{filename}"
        target.write_bytes(contents)
        cover_url = f"/uploads/book_covers/{target.name}"
    return {"course": code, "cover_url": cover_url}


@app.get("/research/collection-covers")
def get_research_collection_covers():
    return list_collection_cover_urls("research")


@app.post("/research/collection-covers/{course_code}", status_code=200)
async def upload_research_collection_cover(
    course_code: str,
    file: UploadFile = File(...),
    admin: User = Depends(require_admin),
):
    return await save_collection_cover("research", course_code, file, admin)


@app.get("/ebooks/collection-covers")
def get_ebook_collection_covers():
    return list_collection_cover_urls("ebooks")


@app.post("/ebooks/collection-covers/{course_code}", status_code=200)
async def upload_ebook_collection_cover(
    course_code: str,
    file: UploadFile = File(...),
    admin: User = Depends(require_admin),
):
    return await save_collection_cover("ebooks", course_code, file, admin)


def ebook_out_from_key(key: str, size: int = 0, cover_exists: bool = False):
    parts = key.split("/")
    stored_name = parts[-1]
    original_name = stored_name.split("__", 1)[-1] if "__" in stored_name else stored_name
    relative_parts = parts[:-1]
    course = relative_parts[0] if len(relative_parts) > 0 else "General"
    year = relative_parts[1] if len(relative_parts) > 1 else ""
    semester = relative_parts[2] if len(relative_parts) > 2 else ""
    subject = relative_parts[3] if len(relative_parts) > 3 else (relative_parts[-1] if len(relative_parts) > 1 else "General")

    # Do not call Storage.info() for every PDF. The catalog endpoint checks
    # the covers bucket once and passes this boolean into the serializer.
    cover_key = f"ebook-covers/{stored_name}"
    cover_url = public_cover_url(cover_key) if cover_exists and supabase else None
    if not supabase:
        for suffix in (".jpg", ".png", ".webp"):
            candidate = BOOK_COVER_DIR / f"ebook-{stored_name}{suffix}"
            if candidate.is_file():
                cover_url = f"/uploads/book_covers/{candidate.name}"
                break

    return {
        "id": stored_name, "title": Path(original_name).stem, "file_name": original_name,
        "author": "Author not listed", "category": course, "course": course,
        "year": year, "semester": semester, "subject": subject,
        "folder_path": "/".join(relative_parts), "description": "", "thumbnail_url": cover_url,
        "preview_url": f"/ebooks/{stored_name}/pdf", "size": str(size),
    }


def ebook_out(path: Path):
    return ebook_out_from_key(path.relative_to(EBOOK_PDF_DIR).as_posix(), path.stat().st_size)


def find_ebook_key(stored_name: str):
    if supabase:
        cached_key = EBOOK_KEY_CACHE.get(stored_name)
        if cached_key:
            return cached_key

        matches = [
            key
            for key in storage_walk(BUCKET_EBOOKS)
            if key.rsplit("/", 1)[-1] == stored_name
        ]
        if matches:
            EBOOK_KEY_CACHE[stored_name] = matches[0]
            return matches[0]
        return None

    matches = list(EBOOK_PDF_DIR.rglob(stored_name))
    return matches[0] if matches else None


@app.get("/ebooks")
def list_ebooks():
    """List e-books with a short server cache and no per-file Storage.info calls."""
    now = time.monotonic()
    cached_items = EBOOK_LIST_CACHE.get("items")
    if cached_items is not None and now - EBOOK_LIST_CACHE["created_at"] < EBOOK_LIST_CACHE_TTL:
        return cached_items

    if supabase:
        keys = storage_walk(BUCKET_EBOOKS)
        # One recursive listing of the cover bucket replaces one info() call
        # per e-book. Missing covers simply use the frontend's normal fallback.
        try:
            cover_keys = set(storage_walk(BUCKET_COVERS))
        except Exception:
            cover_keys = set()

        result = []
        for key in keys:
            stored_name = key.rsplit("/", 1)[-1]
            EBOOK_KEY_CACHE[stored_name] = key
            result.append(
                ebook_out_from_key(
                    key,
                    0,
                    f"ebook-covers/{stored_name}" in cover_keys,
                )
            )
    else:
        files = [
            p for p in EBOOK_PDF_DIR.rglob("*.pdf")
            if p.is_file() and not p.name.startswith(".")
        ]
        result = [ebook_out(p) for p in files]

    result = sorted(result, key=lambda item: item["title"].casefold())
    EBOOK_LIST_CACHE["items"] = result
    EBOOK_LIST_CACHE["created_at"] = time.monotonic()
    return result


@app.post("/ebooks", status_code=201)
async def upload_ebook(
    file: UploadFile = File(...), category: str = Form(default="General"),
    course: str = Form(default=""), year: str = Form(default=""),
    semester: str = Form(default=""), subject: str = Form(default=""),
    cover: Optional[UploadFile] = File(default=None),
    admin: User = Depends(require_admin),
):
    incoming_name = (file.filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    if not incoming_name.lower().endswith(".pdf"):
        raise HTTPException(status_code=415, detail="PDF files only. Choose a .pdf file.")
    try:
        contents = await file.read(MAX_EBOOK_PDF_BYTES + 1)
    finally:
        await file.close()
    if not contents:
        raise HTTPException(status_code=400, detail="The selected PDF is empty.")
    if len(contents) > MAX_EBOOK_PDF_BYTES:
        raise HTTPException(status_code=413, detail="PDF is too large. Maximum size is 50 MB.")
    if not contents.startswith(b"%PDF-"):
        raise HTTPException(status_code=415, detail="The file does not appear to be a valid PDF.")
    cover_contents = None
    cover_extension = None
    if cover is not None and cover.filename:
        try:
            cover_contents = await cover.read(MAX_BOOK_COVER_BYTES + 1)
        finally:
            await cover.close()
        cover_extension = validate_cover_upload(cover, cover_contents)
    def safe_part(value, fallback):
        cleaned = re.sub(r"[^A-Za-z0-9 _-]", "", (value or fallback)).strip()[:60]
        return cleaned or fallback
    c = safe_part(course or category, "General")
    y = safe_part(year, "Unsorted")
    sem = safe_part(semester, "Unsorted")
    sub = safe_part(subject, "General")
    folders = [c] if c == "General" else [c, y, sem, sub]
    original = re.sub(r"[^A-Za-z0-9._ -]", "_", incoming_name).strip(" .") or "ebook.pdf"
    stored = f"{uuid.uuid4().hex}__{original}"
    key = "/".join(folders + [stored])
    try:
        if supabase:
            storage_upload(BUCKET_EBOOKS, key, contents, "application/pdf")
        else:
            target = EBOOK_PDF_DIR.joinpath(*folders, stored)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(contents)
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Could not save the e-book PDF to storage.") from exc

    if supabase:
        EBOOK_KEY_CACHE[stored] = key
    invalidate_ebook_list_cache()

    if cover_contents is not None and cover_extension:
        if supabase:
            storage_upload(BUCKET_COVERS, f"ebook-covers/{stored}", cover_contents, cover.content_type or "image/jpeg")
        else:
            (BOOK_COVER_DIR / f"ebook-{stored}{cover_extension}").write_bytes(cover_contents)

    return ebook_out_from_key(key, len(contents))


@app.post("/ebooks/import-zip", status_code=201)
async def import_ebook_zip(file: UploadFile = File(...), admin: User = Depends(require_admin)):
    incoming_name = (file.filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    if not incoming_name.lower().endswith(".zip"):
        raise HTTPException(status_code=415, detail="Please choose a .zip archive.")
    try:
        file.file.seek(0, os.SEEK_END); archive_size = file.file.tell(); file.file.seek(0)
        if archive_size <= 0 or archive_size > MAX_EBOOK_ZIP_BYTES:
            raise HTTPException(status_code=413, detail="ZIP archive is empty or exceeds the 2 GB limit.")
        try:
            archive = zipfile.ZipFile(file.file)
        except (zipfile.BadZipFile, OSError) as exc:
            raise HTTPException(status_code=400, detail="The uploaded file is not a valid ZIP archive.") from exc
        imported, skipped, total = [], 0, 0
        try:
            entries = [e for e in archive.infolist() if not e.is_dir() and e.filename.lower().endswith(".pdf")]
            if len(entries) > MAX_EBOOK_ZIP_FILES:
                raise HTTPException(status_code=413, detail=f"ZIP contains too many PDFs. Maximum is {MAX_EBOOK_ZIP_FILES}.")
            for entry in entries:
                raw = entry.filename.replace("\\", "/")
                parts = raw.split("/")
                if not parts or any(p in ("", ".", "..") for p in parts) or raw.startswith("/"):
                    skipped += 1; continue
                if entry.file_size <= 0 or entry.file_size > MAX_EBOOK_PDF_BYTES:
                    skipped += 1; continue
                total += entry.file_size
                if total > MAX_EBOOK_ZIP_EXTRACTED_BYTES:
                    raise HTTPException(status_code=413, detail="Extracted PDFs exceed the 2 GB import limit.")
                if entry.compress_size and entry.file_size / entry.compress_size > 200:
                    skipped += 1; continue
                try:
                    data = archive.read(entry)
                    if not data.startswith(b"%PDF-") or len(data) > MAX_EBOOK_PDF_BYTES:
                        skipped += 1; continue
                    folder_parts = [re.sub(r"[^A-Za-z0-9 _-]", "", p).strip()[:60] or "General" for p in (parts[:-1] or ["General"])]
                    original = re.sub(r"[^A-Za-z0-9._ -]", "_", Path(parts[-1]).name).strip(" .") or "ebook.pdf"
                    stored = f"{uuid.uuid4().hex}__{original}"
                    key = "/".join(folder_parts + [stored])
                    if supabase:
                        storage_upload(BUCKET_EBOOKS, key, data, "application/pdf")
                    else:
                        target = EBOOK_PDF_DIR.joinpath(*folder_parts, stored)
                        target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
                    imported.append(ebook_out_from_key(key, len(data)))
                except Exception:
                    skipped += 1
        finally:
            archive.close()
        if not imported:
            raise HTTPException(status_code=400, detail="No valid PDFs could be imported.")
        return {"imported": len(imported), "skipped": skipped, "ebooks": imported}
    finally:
        await file.close()


@app.post("/ebooks/{ebook_id}/cover", status_code=200)
async def upload_ebook_cover(ebook_id: str, file: UploadFile = File(...), admin: User = Depends(require_admin)):
    safe_id = Path(ebook_id).name
    if safe_id != ebook_id or not safe_id.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Invalid e-book ID.")
    match = find_ebook_key(safe_id)
    if not match:
        raise HTTPException(status_code=404, detail="E-book PDF not found.")
    try:
        contents = await file.read(MAX_BOOK_COVER_BYTES + 1)
    finally:
        await file.close()
    extension = validate_cover_upload(file, contents)
    if supabase:
        cover_key = f"ebook-covers/{safe_id}"
        # Keep a stable key so replacing a cover does not change the PDF record.
        storage_upload(BUCKET_COVERS, cover_key, contents, file.content_type or "image/jpeg")
        cover_url = public_cover_url(cover_key)
    else:
        cover_name = f"ebook-{safe_id}{extension}"
        for suffix in (".jpg", ".png", ".webp"):
            (BOOK_COVER_DIR / f"ebook-{safe_id}{suffix}").unlink(missing_ok=True)
        (BOOK_COVER_DIR / cover_name).write_bytes(contents)
        cover_url = f"/uploads/book_covers/{cover_name}"
    invalidate_ebook_list_cache()
    return {"id": safe_id, "thumbnail_url": cover_url}


@app.delete("/ebooks/{ebook_id}")
def delete_ebook(ebook_id: str, admin: User = Depends(require_admin)):
    safe_id = Path(ebook_id).name
    if safe_id != ebook_id or not safe_id.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Invalid e-book ID.")
    match = find_ebook_key(safe_id)
    if not match:
        raise HTTPException(status_code=404, detail="E-book PDF not found.")
    try:
        if supabase:
            storage_remove(BUCKET_EBOOKS, match)
        else:
            match.unlink()
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Could not delete the e-book PDF.") from exc

    EBOOK_KEY_CACHE.pop(safe_id, None)
    invalidate_ebook_list_cache()
    if supabase:
        try: storage_remove(BUCKET_COVERS, f"ebook-covers/{safe_id}")
        except Exception: pass
    else:
        for suffix in (".jpg", ".png", ".webp"):
            (BOOK_COVER_DIR / f"ebook-{safe_id}{suffix}").unlink(missing_ok=True)

    return {"message": "E-book deleted successfully.", "id": safe_id}


@app.get("/ebooks/{ebook_id}/pdf")
def read_ebook_pdf(ebook_id: str):
    safe_id = Path(ebook_id).name
    if safe_id != ebook_id:
        raise HTTPException(status_code=400, detail="Invalid e-book ID.")
    match = find_ebook_key(safe_id)
    if not match:
        raise HTTPException(status_code=404, detail="E-book PDF not found.")
    if supabase:
        return storage_pdf_response(BUCKET_EBOOKS, match, safe_id.split("__", 1)[-1])
    return FileResponse(path=match, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="{safe_id.split("__", 1)[-1]}"', "X-Content-Type-Options": "nosniff"})


# =========================================================
# RESEARCH LIBRARY (PUBLIC READ; ADMIN MANAGE)
# =========================================================

def research_out(item: Research):
    return {
        "id": item.id,
        "title": item.title,
        "authors": item.authors,
        "teacher": item.teacher,
        "year": item.year,
        "course": item.course,
        "subject": item.subject,
        "research_type": item.research_type,
        "abstract": item.abstract,
        "verification_status": item.verification_status,
        "campus": item.campus,
        "url": item.url or "",
        "note": item.note,
        "has_pdf": bool(item.pdf_filename),
        "pdf_url": f"/research/{item.id}/pdf" if item.pdf_filename else None,
        "cover_image": public_cover_url(item.cover_image),
    }

@app.get("/courses")
def list_academic_courses(db: Session = Depends(get_db)):
    """Return admin-added courses; built-in courses remain in the frontend."""
    return [item.code for item in db.scalars(select(AcademicCourse).order_by(AcademicCourse.code)).all()]


@app.post("/courses", status_code=201)
def create_academic_course(
    payload: AcademicCourseCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    code = re.sub(r"\s+", " ", payload.code.strip()).upper()
    if not code:
        raise HTTPException(status_code=422, detail="Course name cannot be empty.")
    existing = db.scalar(select(AcademicCourse).where(AcademicCourse.code.ilike(code)))
    if code in {"BSIT", "BSBA", "BSED"} or existing:
        raise HTTPException(status_code=409, detail="This course already exists.")
    item = AcademicCourse(code=code)
    db.add(item)
    db.commit()
    db.refresh(item)
    return {"id": item.id, "code": item.code}


@app.delete("/courses/{course_code}")
def delete_academic_course(course_code: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    item = db.scalar(select(AcademicCourse).where(AcademicCourse.code.ilike(course_code.strip())))
    if not item:
        raise HTTPException(status_code=404, detail="Course not found.")
    code = item.code
    has_research = db.scalar(select(Research.id).where(Research.course.ilike(code)).limit(1)) is not None
    has_users = db.scalar(select(User.id).where(User.course.ilike(code)).limit(1)) is not None
    ebook_prefix_exists = False
    try:
        if supabase:
            ebook_prefix_exists = any(key == code or key.startswith(f"{code}/") for key in storage_walk(BUCKET_EBOOKS))
        else:
            ebook_prefix_exists = (EBOOK_PDF_DIR / code).exists()
    except Exception:
        raise HTTPException(status_code=503, detail="Could not verify whether this course still has e-books. Try again.")
    if has_research or has_users or ebook_prefix_exists:
        raise HTTPException(status_code=409, detail="This course cannot be deleted because it is still assigned to users, research, or e-books. Move those records to another course first.")
    db.delete(item)
    db.commit()
    return {"message": "Course deleted successfully.", "code": code}


@app.get("/research")
def list_research(
    q: Optional[str] = None,
    course: Optional[str] = None,
    db: Session = Depends(get_db),
):
    stmt = select(Research)
    if q and q.strip():
        term = f"%{q.strip()}%"
        stmt = stmt.where(
            (Research.title.ilike(term))
            | (Research.authors.ilike(term))
            | (Research.subject.ilike(term))
            | (Research.abstract.ilike(term))
            | (Research.research_type.ilike(term))
            | (Research.course.ilike(term))
            | (Research.campus.ilike(term))
            | (Research.note.ilike(term))
        )
    if course and course.strip():
        stmt = stmt.where(Research.course.ilike(course.strip()))
    return [
        research_out(item)
        for item in db.scalars(stmt.order_by(Research.course, Research.title)).all()
    ]

@app.post("/research", status_code=201)
def create_research(
    payload: ResearchCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    url = (payload.url or "").strip()
    if url and not url.startswith(("https://", "http://")):
        raise HTTPException(
            status_code=422,
            detail="Research URL must start with http:// or https://, or be left blank when uploading a PDF.",
        )
    item = Research(**payload.model_dump(exclude={"url"}), url=url)
    item.title = clean_required(item.title, "Title")
    item.course = clean_required(item.course, "Course")
    db.add(item)
    db.commit()
    db.refresh(item)
    return research_out(item)

@app.patch("/research/{research_id}")
def update_research(
    research_id: int,
    payload: ResearchUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    item = db.get(Research, research_id)
    if not item:
        raise HTTPException(status_code=404, detail="Research not found.")
    changes = payload.model_dump(exclude_unset=True)
    if "url" in changes and changes["url"]:
        url = changes["url"].strip()
        if not url.startswith(("https://", "http://")):
            raise HTTPException(
                status_code=422,
                detail="Research URL must start with http:// or https://, or be left blank when uploading a PDF.",
            )
        changes["url"] = url
    for key, value in changes.items():
        if isinstance(value, str):
            value = value.strip()
        if key == "note":
            value = value or None
        elif key == "url":
            value = value or ""
        setattr(item, key, value)
    db.commit()
    db.refresh(item)
    return research_out(item)

@app.post("/research/{research_id}/cover", status_code=200)
async def upload_research_cover(research_id: int, file: UploadFile = File(...), db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    item = db.get(Research, research_id)
    if not item:
        raise HTTPException(status_code=404, detail="Research not found.")
    try:
        contents = await file.read(MAX_BOOK_COVER_BYTES + 1)
    finally:
        await file.close()
    extension = validate_cover_upload(file, contents)
    stored = f"research-{research_id}-{uuid.uuid4().hex}{extension}"
    previous = item.cover_image
    try:
        if supabase:
            storage_upload(BUCKET_COVERS, f"research-covers/{stored}", contents, file.content_type or "image/jpeg")
            item.cover_image = f"research-covers/{stored}"
        else:
            target = BOOK_COVER_DIR / stored
            target.write_bytes(contents)
            item.cover_image = stored
        db.commit()
        db.refresh(item)
    except Exception as exc:
        db.rollback()
        if supabase:
            try: storage_remove(BUCKET_COVERS, f"research-covers/{stored}")
            except Exception: pass
        else:
            (BOOK_COVER_DIR / stored).unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Could not save the research cover.") from exc
    if previous:
        if supabase:
            try: storage_remove(BUCKET_COVERS, previous)
            except Exception: pass
        else:
            (BOOK_COVER_DIR / Path(previous).name).unlink(missing_ok=True)
    return research_out(item)


@app.post("/research/{research_id}/pdf", status_code=200)
async def upload_research_pdf(research_id: int, file: UploadFile = File(...), db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    item = db.get(Research, research_id)
    if not item:
        raise HTTPException(status_code=404, detail="Research not found.")
    incoming = (file.filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    if not incoming.lower().endswith(".pdf") or file.content_type not in ("application/pdf", "application/octet-stream", None):
        raise HTTPException(status_code=415, detail="Please upload a valid PDF file.")
    try:
        contents = await file.read(MAX_RESEARCH_PDF_BYTES + 1)
    finally:
        await file.close()
    if not contents or len(contents) > MAX_RESEARCH_PDF_BYTES or not contents.startswith(b"%PDF-"):
        raise HTTPException(status_code=400, detail="PDF is empty, invalid, or exceeds the 25 MB limit.")
    stored = f"research-{research_id}-{uuid.uuid4().hex}.pdf"
    previous = item.pdf_filename
    try:
        if supabase:
            storage_upload(BUCKET_RESEARCH, stored, contents, "application/pdf")
        else:
            (RESEARCH_PDF_DIR / stored).write_bytes(contents)
        item.pdf_filename = stored
        db.commit(); db.refresh(item)
    except Exception as exc:
        db.rollback()
        if supabase:
            try: storage_remove(BUCKET_RESEARCH, stored)
            except Exception: pass
        else:
            (RESEARCH_PDF_DIR / stored).unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Could not save the PDF to the Research Library.") from exc
    if previous:
        if supabase:
            try: storage_remove(BUCKET_RESEARCH, Path(previous).name)
            except Exception: pass
        else:
            (RESEARCH_PDF_DIR / Path(previous).name).unlink(missing_ok=True)
    return research_out(item)


@app.get("/research/{research_id}/pdf")
def read_research_pdf(research_id: int, db: Session = Depends(get_db)):
    item = db.get(Research, research_id)
    if not item or not item.pdf_filename:
        raise HTTPException(status_code=404, detail="No uploaded PDF is attached to this research.")
    safe_name = Path(item.pdf_filename).name
    if supabase:
        return storage_pdf_response(BUCKET_RESEARCH, safe_name, f"LibTrack-Research-{research_id}.pdf")
    pdf_path = RESEARCH_PDF_DIR / safe_name
    if not pdf_path.is_file():
        raise HTTPException(status_code=404, detail="The uploaded PDF file could not be found on the server.")
    return FileResponse(path=pdf_path, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="LibTrack-Research-{research_id}.pdf"', "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600"})


@app.delete("/research/{research_id}")
def delete_research(research_id: int, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    item = db.get(Research, research_id)
    if not item:
        raise HTTPException(status_code=404, detail="Research not found.")
    filename = item.pdf_filename
    cover_filename = item.cover_image
    db.delete(item); db.commit()
    if cover_filename:
        if supabase:
            try: storage_remove(BUCKET_COVERS, cover_filename)
            except Exception: pass
        else:
            (BOOK_COVER_DIR / Path(cover_filename).name).unlink(missing_ok=True)
    if filename:
        if supabase:
            try: storage_remove(BUCKET_RESEARCH, Path(filename).name)
            except Exception: pass
        else:
            (RESEARCH_PDF_DIR / Path(filename).name).unlink(missing_ok=True)
    return {"message": "Research deleted successfully.", "id": research_id}

# =========================================================
# BOOK CATALOG (PUBLIC READ)
# =========================================================


def has_real_book_author(value: Optional[str]) -> bool:
    """True only when the author field contains an identifiable credited author."""
    author = re.sub(r"\s+", " ", (value or "")).strip()
    if not author:
        return False

    normalized = author.casefold().strip(" .")
    placeholders = {
        "unknown", "not listed", "author not listed", "author not verified",
        "needs edition/isbn verification", "various authors",
        "various authors (not individually identified)", "n/a", "na", "none", "-",
        "not specified", "not stated", "author unavailable",
    }
    if normalized in placeholders:
        return False

    # These phrases describe missing/uncertain attribution rather than an author.
    missing_author_phrases = (
        "individual authors are not identified",
        "individual author is not identified",
        "individual authors not identified",
        "author not listed",
        "author not verified",
        "needs edition/isbn verification",
        "authors are not identified",
        "authors not identified",
        "author not identified",
        "publisher/editorial team not identified",
        "editor not yet verified",
        "editor not identified",
        "individual volume editors vary",
        "varies by annual edition",
        "varies by anthology",
        "varies by issue",
        "contributing authors and editors; varies",
    )
    return not any(phrase in normalized for phrase in missing_author_phrases)

@app.get("/books")
def list_books(
    q: Optional[str] = None,
    category: Optional[str] = None,
    db: Session = Depends(get_db),
):
    # Show catalog books with a real author. Older records with a credited
    # author remain visible even if they were previously marked inactive.
    stmt = select(Book)

    if q and q.strip():
        search_term = f"%{q.strip()}%"
        stmt = stmt.where(
            (Book.title.ilike(search_term))
            | (Book.author.ilike(search_term))
            | (Book.isbn.ilike(search_term))
            | (Book.call_number.ilike(search_term))
        )

    if category and category.strip():
        stmt = stmt.where(
            Book.category.ilike(f"%{category.strip()}%")
        )

    books = db.scalars(stmt.order_by(Book.title)).all()
    return [
        book_out(book)
        for book in books
        if has_real_book_author(book.author)
    ]

@app.get("/reports/most-borrowed")
def most_borrowed_books(
    limit: int = 6,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return books ranked by completed/approved borrowing transactions.

    Pending requests are excluded so the ranking reflects books that were
    actually approved and borrowed. Returned transactions remain in the
    count because they represent a completed borrowing.
    """
    safe_limit = max(1, min(limit, 12))
    rows = db.execute(
        select(
            Book,
            func.count(Borrowing.id).label("borrow_count"),
        )
        .join(Borrowing, Borrowing.book_id == Book.id)
        .where(
            Book.is_active.is_(True),
            Borrowing.status.in_(("borrowed", "returned")),
        )
        .group_by(Book.id)
        .order_by(
            func.count(Borrowing.id).desc(),
            Book.title.asc(),
        )
        .limit(safe_limit)
    ).all()

    return [
        {
            **book_out(book),
            "borrow_count": int(borrow_count),
        }
        for book, borrow_count in rows
    ]


@app.get("/reports/most-borrowing-students")
def most_borrowing_students(
    limit: int = 10,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Rank active student accounts by approved borrowing transactions."""
    safe_limit = max(1, min(limit, 25))
    rows = db.execute(
        select(
            User,
            func.count(Borrowing.id).label("borrow_count"),
        )
        .join(Borrowing, Borrowing.user_id == User.id)
        .where(
            User.role == "student",
            User.active.is_(True),
            Borrowing.status.in_(("borrowed", "returned")),
        )
        .group_by(User.id)
        .order_by(
            func.count(Borrowing.id).desc(),
            User.full_name.asc(),
        )
        .limit(safe_limit)
    ).all()

    return [
        {
            "id": student.id,
            "full_name": student.full_name,
            "student_id": student.student_id,
            "course": student.course,
            "year": student.year,
            "section": student.section,
            "borrow_count": int(borrow_count),
        }
        for student, borrow_count in rows
    ]


@app.get("/books/{book_id}")
def get_book(
    book_id: int,
    db: Session = Depends(get_db),
):
    book = db.get(Book, book_id)

    if not book or not has_real_book_author(book.author):
        raise HTTPException(
            status_code=404,
            detail="Book not found.",
        )

    return book_out(book)

# =========================================================
# BOOK MANAGEMENT (ADMIN ONLY)
# =========================================================

@app.post("/books", status_code=201)
def create_book(
    payload: BookCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    book = Book(
        title=clean_required(payload.title, "Title"),
        author=clean_required(payload.author, "Author"),
        category=clean_required(payload.category, "Category"),
        isbn=payload.isbn.strip() or None if payload.isbn else None,
        call_number=payload.call_number.strip() or None if payload.call_number else None,
        description=payload.description.strip() or None if payload.description else None,
        total_copies=payload.total_copies,
        available_copies=payload.total_copies,
    )

    db.add(book)
    db.commit()
    db.refresh(book)
    return book_out(book)

@app.patch("/books/{book_id}")
def update_book(
    book_id: int,
    payload: BookUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    book = db.get(Book, book_id)

    if not book:
        raise HTTPException(
            status_code=404,
            detail="Book not found.",
        )

    changes = payload.model_dump(exclude_unset=True)

    if not changes:
        raise HTTPException(
            status_code=400,
            detail="No changes provided.",
        )

    borrowed_copies = book.total_copies - book.available_copies
    new_total = changes.get("total_copies", book.total_copies)

    if new_total is None or new_total < borrowed_copies:
        raise HTTPException(
            status_code=409,
            detail=f"Total copies cannot be below {borrowed_copies} borrowed copies.",
        )

    for field in ("title", "author", "category"):
        if field in changes:
            if changes[field] is None:
                raise HTTPException(
                    status_code=422,
                    detail=f"{field} cannot be null.",
                )
            changes[field] = clean_required(changes[field], field)

    if "isbn" in changes and changes["isbn"] is not None:
        changes["isbn"] = changes["isbn"].strip() or None
    if "call_number" in changes and changes["call_number"] is not None:
        changes["call_number"] = changes["call_number"].strip() or None
    if "description" in changes and changes["description"] is not None:
        changes["description"] = changes["description"].strip() or None

    for field in ("title", "author", "category", "isbn", "call_number", "description"):
        if field in changes:
            setattr(book, field, changes[field])

    if "total_copies" in changes:
        book.total_copies = new_total
        book.available_copies = new_total - borrowed_copies

    db.commit()
    db.refresh(book)
    return book_out(book)

@app.post("/books/{book_id}/cover", status_code=200)
async def upload_book_cover(book_id: int, file: UploadFile = File(...), db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    book = db.get(Book, book_id)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found.")
    allowed = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
    extension = allowed.get(file.content_type or "")
    if not extension:
        raise HTTPException(status_code=415, detail="Choose a JPG, PNG, or WEBP image.")
    try:
        contents = await file.read(MAX_BOOK_COVER_BYTES + 1)
    finally:
        await file.close()
    if not contents or len(contents) > MAX_BOOK_COVER_BYTES:
        raise HTTPException(status_code=413, detail="Book cover is empty or exceeds 5 MB.")
    filename = f"book_{book_id}_{uuid.uuid4().hex}{extension}"
    old_filename = book.cover_image.rsplit("/", 1)[-1] if book.cover_image else None
    try:
        if supabase:
            storage_upload(BUCKET_COVERS, filename, contents, file.content_type or "application/octet-stream")
        else:
            (BOOK_COVER_DIR / filename).write_bytes(contents)
        book.cover_image = f"/uploads/book_covers/{filename}"
        db.commit(); db.refresh(book)
    except Exception as exc:
        db.rollback()
        if supabase:
            try: storage_remove(BUCKET_COVERS, filename)
            except Exception: pass
        else:
            (BOOK_COVER_DIR / filename).unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Could not save the book cover.") from exc
    if old_filename and old_filename != filename:
        if supabase:
            try: storage_remove(BUCKET_COVERS, Path(old_filename).name)
            except Exception: pass
        else:
            (BOOK_COVER_DIR / Path(old_filename).name).unlink(missing_ok=True)
    return book_out(book)


@app.delete("/books/{book_id}")
def delete_book(
    book_id: int,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    book = db.get(Book, book_id)

    if not book:
        raise HTTPException(
            status_code=404,
            detail="Book not found.",
        )

    history_id = db.scalar(
        select(Borrowing.id)
        .where(Borrowing.book_id == book_id)
        .limit(1)
    )

    if history_id is not None:
        raise HTTPException(
            status_code=409,
            detail="Cannot delete a book with borrowing history.",
        )

    db.delete(book)
    db.commit()

    return {
        "message": "Book deleted successfully.",
        "id": book_id,
    }

# =========================================================
# BORROW BOOKS
# =========================================================

@app.post("/borrowings", status_code=201)
def borrow_book(
    payload: BorrowCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role in ("student", "faculty"):
        if payload.user_id is not None and payload.user_id != current_user.id:
            raise HTTPException(
                status_code=403,
                detail="You can only borrow books for yourself.",
            )
        borrower_id = current_user.id

    elif current_user.role == "admin":
        if payload.user_id is None:
            raise HTTPException(
                status_code=422,
                detail="Admin must provide a user_id.",
            )
        borrower_id = payload.user_id

    else:
        raise HTTPException(
            status_code=403,
            detail="This role cannot borrow books.",
        )

    user = db.get(User, borrower_id)
    book = db.get(Book, payload.book_id)

    if not user or not user.active:
        raise HTTPException(
            status_code=404,
            detail="Active user not found.",
        )
    if user.borrowing_suspended:
        raise HTTPException(
            status_code=403,
            detail="Your library borrowing privileges are suspended because you have an unsettled lost/damaged book case. Please contact the Librarian.",
        )

    # Enforce the Admin-configured borrowing schedule using Philippine Time.
    if user.role in ("student", "faculty"):
        enforce_borrowing_schedule(db)

    if not book or not book.is_active:
        raise HTTPException(
            status_code=404,
            detail="Book not found or no longer in the active catalog.",
        )

    if book.available_copies < 1:
        raise HTTPException(
            status_code=409,
            detail="No available copies.",
        )

    # Student requests are pending until an Admin approves and assigns the due date.
    # The database column is non-null, so use today's date temporarily for pending records.
    # This placeholder is replaced with the Admin-selected date during approval.
    record = Borrowing(
        user_id=user.id,
        book_id=book.id,
        due_date=payload.due_date if payload.due_date is not None else date.today(),
        status="pending",
    )

    db.add(record)
    db.commit()
    db.refresh(record)

    return borrowing_out(record)

# =========================================================
# APPROVE BORROWING REQUESTS (ADMIN ONLY)
# =========================================================

@app.post("/borrowings/{borrowing_id}/approve")
def approve_borrowing(
    borrowing_id: int,
    payload: BorrowApproval,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    today = date.today()
    if payload.due_date < today:
        raise HTTPException(
            status_code=400,
            detail="Due date cannot be in the past.",
        )
    if payload.due_date > today + timedelta(days=7):
        raise HTTPException(
            status_code=400,
            detail="Return due date cannot be more than 7 days from today.",
        )

    record = db.get(Borrowing, borrowing_id)
    if not record:
        raise HTTPException(status_code=404, detail="Borrowing request not found.")
    if record.status != "pending":
        raise HTTPException(status_code=409, detail="Only pending requests can be approved.")

    user = db.get(User, record.user_id)
    book = db.get(Book, record.book_id)
    if not user or not user.active:
        raise HTTPException(status_code=404, detail="Active student account not found.")
    if not book:
        raise HTTPException(status_code=404, detail="Book not found.")
    if book.available_copies < 1:
        raise HTTPException(status_code=409, detail="No available copies remain; request cannot be approved.")

    book.available_copies -= 1
    record.due_date = payload.due_date
    record.status = "borrowed"
    record.borrowed_at = datetime.utcnow()
    db.commit()
    db.refresh(record)
    return borrowing_out(record)

# =========================================================
# BORROWING HISTORY
# =========================================================

@app.get("/borrowings")
def list_borrowings(
    status_filter: Optional[str] = None,
    user_id: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    stmt = select(Borrowing)

    if current_user.role == "student":
        stmt = stmt.where(
            Borrowing.user_id == current_user.id
        )
    elif current_user.role == "admin":
        if user_id is not None:
            stmt = stmt.where(Borrowing.user_id == user_id)
    else:
        raise HTTPException(
            status_code=403,
            detail="Access denied.",
        )

    if status_filter:
        if status_filter not in ("pending", "borrowed", "returned"):
            raise HTTPException(
                status_code=400,
                detail="Status must be pending, borrowed, or returned.",
            )
        stmt = stmt.where(Borrowing.status == status_filter)

    rows = db.scalars(
        stmt.order_by(Borrowing.borrowed_at.desc())
    ).all()

    return [borrowing_out(row) for row in rows]

# =========================================================
# LOST / DAMAGED BOOKS (ADMIN ONLY)
# =========================================================

@app.get("/lost-books")
def list_lost_book_cases(
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    rows = db.scalars(select(LostBookCase).order_by(LostBookCase.created_at.desc())).all()
    return [lost_book_case_out(row) for row in rows]



def create_user_notification(db: Session, user_id: int, title: str, message: str, notification_type: str = "library"):
    db.add(UserNotification(
        user_id=user_id,
        title=title,
        message=message,
        notification_type=notification_type,
        is_read=False,
    ))


@app.get("/notifications")
def get_my_notifications(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Backfill notifications for Lost/Damaged cases created before this feature
    # was added. Exact-message checks make this safe to run on every refresh.
    existing_cases = db.scalars(
        select(LostBookCase)
        .where(LostBookCase.user_id == current_user.id)
        .order_by(LostBookCase.created_at.asc())
    ).all()

    added_backfill = False
    for case in existing_cases:
        book = db.get(Book, case.book_id)
        book_title = book.title if book else f"Book #{case.book_id}"
        case_type = (case.case_type or "lost").lower()
        report_title = f"{case_type.title()} book case reported"
        report_message = (
            f"A {case_type} book case was recorded for “{book_title}”. "
            f"Your borrowing privileges are temporarily suspended until the case is settled. "
            f"Amount due: PHP {float(case.amount_due or 0):.2f}. "
            f"Settlement deadline: {case.deadline.isoformat()}."
        )
        report_exists = db.scalar(
            select(UserNotification.id).where(
                UserNotification.user_id == current_user.id,
                UserNotification.notification_type == "lost_damaged_book",
                UserNotification.title == report_title,
                UserNotification.message == report_message,
            ).limit(1)
        )
        if not report_exists:
            create_user_notification(
                db, current_user.id, report_title, report_message, "lost_damaged_book"
            )
            added_backfill = True

        if case.resolution_status in ("paid", "replaced"):
            status_label = (
                "payment received" if case.resolution_status == "paid"
                else "replacement received"
            )
            resolution_title = "Lost/damaged book case updated"
            resolution_message = (
                f"The library has confirmed that your {case_type} book case for "
                f"“{book_title}” has been settled ({status_label}). "
                f"Your borrowing restriction has been updated."
            )
            resolution_exists = db.scalar(
                select(UserNotification.id).where(
                    UserNotification.user_id == current_user.id,
                    UserNotification.notification_type == "lost_damaged_book",
                    UserNotification.title == resolution_title,
                    UserNotification.message == resolution_message,
                ).limit(1)
            )
            if not resolution_exists:
                create_user_notification(
                    db, current_user.id, resolution_title,
                    resolution_message, "lost_damaged_book"
                )
                added_backfill = True

    if added_backfill:
        db.commit()

    rows = db.scalars(
        select(UserNotification)
        .where(UserNotification.user_id == current_user.id)
        .order_by(UserNotification.created_at.desc())
        .limit(100)
    ).all()
    return [{
        "id": row.id,
        "title": row.title,
        "message": row.message,
        "notification_type": row.notification_type,
        "is_read": row.is_read,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    } for row in rows]


@app.post("/notifications/{notification_id}/read")
def mark_my_notification_read(
    notification_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    row = db.get(UserNotification, notification_id)
    if not row or row.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Notification not found.")
    row.is_read = True
    db.commit()
    return {"success": True}


@app.post("/borrowings/{borrowing_id}/report-lost")
def report_lost_or_damaged_book(
    borrowing_id: int,
    payload: LostBookReport,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    record = db.get(Borrowing, borrowing_id)
    if not record:
        raise HTTPException(status_code=404, detail="Borrowing record not found.")
    if record.status != "borrowed":
        raise HTTPException(status_code=409, detail="Only currently borrowed books can be reported lost or damaged.")
    existing = db.scalar(select(LostBookCase).where(LostBookCase.borrowing_id == borrowing_id))
    if existing:
        raise HTTPException(status_code=409, detail="A lost/damaged case already exists for this borrowing record.")

    today = date.today()
    deadline = payload.deadline or (today + timedelta(days=15))
    if deadline < today or deadline > today + timedelta(days=30):
        raise HTTPException(status_code=400, detail="The settlement deadline must be within 30 days from the report date.")

    # NEUST manual: lost book = current value + PHP 50 processing fee.
    # Additional fines are accepted only up to the documented value + PHP 50 ceiling.
    cap = float(payload.market_value) + 50.0
    requested_total = float(payload.market_value) + 50.0 + float(payload.additional_fine)
    amount_due = min(requested_total, cap)

    case = LostBookCase(
        borrowing_id=record.id,
        user_id=record.user_id,
        book_id=record.book_id,
        report_date=today,
        market_value=payload.market_value,
        processing_fee=50,
        additional_fine=max(0.0, amount_due - float(payload.market_value) - 50.0),
        amount_due=amount_due,
        deadline=deadline,
        case_type=payload.case_type,
        resolution_status="unsettled",
        resolution_note=payload.note,
    )
    record.status = "lost"
    user = db.get(User, record.user_id)
    if user:
        user.borrowing_suspended = True
    book = db.get(Book, record.book_id)
    if book:
        # The missing/damaged copy is no longer counted as part of the collection.
        book.total_copies = max(book.available_copies, book.total_copies - 1)
    db.add(case)
    book_title = book.title if book else f"Book #{record.book_id}"
    create_user_notification(
        db,
        record.user_id,
        f"{payload.case_type.title()} book case reported",
        f"A {payload.case_type} book case was recorded for “{book_title}”. Your borrowing privileges are temporarily suspended until the case is settled. Amount due: PHP {amount_due:.2f}. Settlement deadline: {deadline.isoformat()}.",
        "lost_damaged_book",
    )
    db.commit()
    db.refresh(case)
    return lost_book_case_out(case)



@app.post("/lost-books/{case_id}/receipt")
async def upload_lost_book_receipt(
    case_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    case = db.get(LostBookCase, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Lost/damaged book case not found.")
    if not SUPABASE_ENABLED or not supabase:
        raise HTTPException(status_code=503, detail="Receipt storage is not configured. Check backend Supabase credentials.")
    content_type = (file.content_type or "").lower()
    if content_type not in ALLOWED_RECEIPT_TYPES:
        raise HTTPException(status_code=415, detail="Only JPG, PNG, WEBP, or PDF receipts are allowed.")
    contents = await file.read(MAX_RECEIPT_BYTES + 1)
    if not contents:
        raise HTTPException(status_code=400, detail="The selected receipt file is empty.")
    if len(contents) > MAX_RECEIPT_BYTES:
        raise HTTPException(status_code=413, detail="Receipt file must be 5 MB or smaller.")
    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", Path(file.filename or "receipt").name)[:120]
    key = f"case-{case.id}/{uuid.uuid4().hex}_{safe_name}"
    try:
        storage_upload(BUCKET_RECEIPTS, key, contents, content_type)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Could not upload the receipt to Supabase Storage. Confirm the receipt-attachments bucket exists.") from exc

    old_note = case.resolution_note or ""
    old_note = re.sub(r"(?:\s*\|\s*)?Receipt Storage Key: [^|]+", "", old_note).strip(" |")
    case.resolution_note = " | ".join(part for part in [old_note, f"Receipt Attachment: {safe_name}", f"Receipt Storage Key: {key}"] if part)
    db.commit()
    return {"success": True, "filename": safe_name}


@app.get("/lost-books/{case_id}/receipt")
def view_lost_book_receipt(
    case_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    case = db.get(LostBookCase, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Lost/damaged book case not found.")
    if current_user.role != "admin" and current_user.id != case.user_id:
        raise HTTPException(status_code=403, detail="You are not allowed to view this receipt.")
    match = re.search(r"Receipt Storage Key: ([^|]+)", case.resolution_note or "")
    if not match:
        raise HTTPException(status_code=404, detail="No receipt attachment has been uploaded for this case.")
    if not SUPABASE_ENABLED or not supabase:
        raise HTTPException(status_code=503, detail="Receipt storage is not configured.")
    key = match.group(1).strip()
    try:
        contents = storage_download(BUCKET_RECEIPTS, key)
    except Exception as exc:
        raise HTTPException(status_code=404, detail="Receipt attachment could not be found in storage.") from exc
    extension = Path(key).suffix.lower()
    media_type = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".pdf": "application/pdf"}.get(extension, "application/octet-stream")
    filename = Path(key).name.split("_", 1)[-1]
    return Response(
        content=contents,
        media_type=media_type,
        headers={"Content-Disposition": f'inline; filename="{filename}"', "Cache-Control": "private, no-store"},
    )


@app.post("/lost-books/{case_id}/resolve")
def resolve_lost_book_case(
    case_id: int,
    payload: LostBookResolution,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    case = db.get(LostBookCase, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Lost/damaged book case not found.")
    if case.resolution_status != "unsettled":
        raise HTTPException(status_code=409, detail="This case has already been resolved.")

    case.resolution_status = payload.resolution_status
    existing_receipt_key = re.search(r"Receipt Storage Key: ([^|]+)", case.resolution_note or "")
    submitted_note = payload.note or case.resolution_note or ""
    if existing_receipt_key and "Receipt Storage Key:" not in submitted_note:
        submitted_note = " | ".join(part for part in [submitted_note.strip(" |"), f"Receipt Storage Key: {existing_receipt_key.group(1).strip()}"] if part)
    case.resolution_note = submitted_note
    case.resolved_at = datetime.utcnow()

    if payload.resolution_status in ("paid", "replaced"):
        user = db.get(User, case.user_id)
        if user:
            other_open_cases = db.scalar(
                select(func.count(LostBookCase.id)).where(
                    LostBookCase.user_id == case.user_id,
                    LostBookCase.id != case.id,
                    LostBookCase.resolution_status == "unsettled",
                )
            ) or 0
            user.borrowing_suspended = other_open_cases > 0

        if payload.resolution_status == "replaced":
            book = db.get(Book, case.book_id)
            if book:
                book.total_copies += 1
                # Replacement becomes a new available copy.
                book.available_copies += 1

    book = db.get(Book, case.book_id)
    book_title = book.title if book else f"Book #{case.book_id}"
    if payload.resolution_status in ("paid", "replaced"):
        status_label = "payment received" if payload.resolution_status == "paid" else "replacement received"
        create_user_notification(
            db,
            case.user_id,
            "Lost/damaged book case updated",
            f"The library has confirmed that your {case.case_type} book case for “{book_title}” has been settled ({status_label}). Your borrowing restriction has been updated.",
            "lost_damaged_book",
        )
    db.commit()
    db.refresh(case)
    return lost_book_case_out(case)


# =========================================================
# RETURN BOOKS (ADMIN ONLY)
# =========================================================

@app.post("/borrowings/{borrowing_id}/return")
def return_book(
    borrowing_id: int,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    record = db.get(Borrowing, borrowing_id)

    if not record:
        raise HTTPException(
            status_code=404,
            detail="Borrowing record not found.",
        )

    if record.status == "returned":
        raise HTTPException(status_code=409, detail="Book already returned.")
    if record.status != "borrowed":
        raise HTTPException(status_code=409, detail="Only approved borrowing records can be returned.")

    book = db.get(Book, record.book_id)

    if not book:
        raise HTTPException(
            status_code=500,
            detail="Associated book record is missing.",
        )

    book.available_copies = min(
        book.total_copies,
        book.available_copies + 1,
    )

    record.status = "returned"
    record.returned_at = datetime.utcnow()

    db.commit()
    db.refresh(record)

    return {
        "message": "Book return recorded.",
        "borrowing_id": record.id,
        "status": record.status,
    }

# =========================================================
# STUDENT / FACULTY PROBLEM REPORTS
# =========================================================

def problem_report_out(report: ProblemReport, user: Optional[User] = None):
    return {
        "id": report.id,
        "user_id": report.user_id,
        "student_name": user.full_name if user else None,
        "student_email": user.email if user else None,
        "student_id": user.student_id if user else None,
        "category": report.category,
        "description": report.description,
        "status": report.status,
        "admin_note": report.admin_note,
        "created_at": report.created_at.isoformat() if report.created_at else None,
        "updated_at": report.updated_at.isoformat() if report.updated_at else None,
    }


@app.post("/problem-reports", status_code=201)
def submit_problem_report(
    payload: ProblemReportCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    category = payload.category.strip()
    description = payload.description.strip()
    if not category or not description:
        raise HTTPException(status_code=422, detail="Category and description are required.")
    report = ProblemReport(
        user_id=user.id,
        category=category,
        description=description,
        status="pending",
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return {
        "message": "Your problem report was submitted successfully.",
        "report": problem_report_out(report, user),
    }


@app.get("/problem-reports")
def list_problem_reports(
    status_filter: Optional[str] = None,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    if status_filter and status_filter not in ("pending", "in_progress", "resolved"):
        raise HTTPException(status_code=400, detail="Invalid problem report status.")
    stmt = (
        select(ProblemReport, User)
        .join(User, User.id == ProblemReport.user_id)
        .order_by(ProblemReport.created_at.desc())
    )
    if status_filter:
        stmt = stmt.where(ProblemReport.status == status_filter)
    return [problem_report_out(report, owner) for report, owner in db.execute(stmt).all()]


@app.patch("/problem-reports/{report_id}")
def update_problem_report(
    report_id: int,
    payload: ProblemReportUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    report = db.get(ProblemReport, report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Problem report not found.")

    report.status = payload.status
    report.admin_note = (payload.admin_note or "").strip() or None
    report.updated_at = datetime.utcnow()

    if report.status in ("in_progress", "resolved"):
        status_label = "being reviewed" if report.status == "in_progress" else "marked as resolved"
        note_text = f" Admin note: {report.admin_note}" if report.admin_note else ""
        create_user_notification(
            db,
            report.user_id,
            "Your problem report was updated",
            f"The library administrator has {status_label}.{note_text}",
            "problem_report",
        )

    db.commit()
    db.refresh(report)
    owner = db.get(User, report.user_id)
    return {
        "message": "Problem report updated.",
        "report": problem_report_out(report, owner),
    }


# =========================================================
# REPORTS (ADMIN ONLY)
# =========================================================

@app.get("/reports/summary")
def summary(
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    books = db.scalars(select(Book).where(Book.is_active.is_(True))).all()
    users = db.scalars(select(User)).all()
    records = db.scalars(select(Borrowing)).all()

    total_copies = sum(book.total_copies for book in books)
    available_copies = sum(book.available_copies for book in books)
    borrowed_copies = sum(
        max(book.total_copies - book.available_copies, 0)
        for book in books
    )

    return {
        "titles": len(books),
        "total_copies": total_copies,
        "available_copies": available_copies,
        "borrowed_copies": borrowed_copies,
        "unavailable_titles": sum(book.available_copies == 0 for book in books),
        "users": len(users),
        "active_borrowings": sum(record.status == "borrowed" for record in records),
        "pending_borrowings": sum(record.status == "pending" for record in records),
        "returned_transactions": sum(record.status == "returned" for record in records),
        "total_transactions": len(records),
        "overdue_borrowings": sum(
            record.status == "borrowed" and record.due_date < date.today()
            for record in records
        ),
    }


@app.get("/reports/borrowing-statistics")
def borrowing_statistics(
    academic_year: str = "2026-2027",
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Admin-only department statistics. Mid-Year is excluded."""
    if academic_year != "2026-2027":
        raise HTTPException(status_code=400, detail="Currently supported academic year is 2026-2027.")

    records = db.execute(
        select(Borrowing, User, Book)
        .join(User, User.id == Borrowing.user_id)
        .join(Book, Book.id == Borrowing.book_id)
        .where(Borrowing.status.in_(("borrowed", "returned")))
    ).all()

    semester_defs = [
        ("1st", "1st Semester", "July 20 – November 21, 2026", date(2026, 7, 20), date(2026, 11, 21)),
        ("2nd", "2nd Semester", "December 7, 2026 – April 30, 2027", date(2026, 12, 7), date(2027, 4, 30)),
    ]
    semesters = []
    for key, label, date_range, start_date, end_date in semester_defs:
        department_counts = {code: {"total": 0, "book_ids": set()} for code in ("BSIT", "BSED", "BSBA")}
        book_counts = {}
        for borrowing, user, book in records:
            borrowed_at = borrowing.borrowed_at
            borrowed_date = borrowed_at.date() if hasattr(borrowed_at, "date") else borrowed_at
            if borrowed_date is None or not (start_date <= borrowed_date <= end_date):
                continue
            department = (getattr(user, "course", None) or "").strip().upper()
            if department not in department_counts:
                continue
            department_counts[department]["total"] += 1
            department_counts[department]["book_ids"].add(book.id)
            book_counts[book.title] = book_counts.get(book.title, 0) + 1

        departments = {
            code: {"total": values["total"], "unique_books": len(values["book_ids"])}
            for code, values in department_counts.items()
        }
        top_books = [
            {"title": title, "total": count}
            for title, count in sorted(book_counts.items(), key=lambda item: (-item[1], item[0]))[:10]
        ]
        semesters.append({
            "key": key, "label": label, "date_range": date_range,
            "departments": departments,
            "total": sum(item["total"] for item in departments.values()),
            "top_books": top_books,
        })

    return {"academic_year": academic_year, "semesters": semesters, "mid_year_included": False}


@app.get("/reports/transactions")
def transaction_report(
    status_filter: Optional[str] = None,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Admin-only transaction report; read-only and compatible with existing records."""
    if status_filter and status_filter not in ("pending", "borrowed", "returned"):
        raise HTTPException(
            status_code=400,
            detail="Status must be pending, borrowed, or returned.",
        )

    stmt = (
        select(Borrowing, User, Book)
        .join(User, User.id == Borrowing.user_id)
        .join(Book, Book.id == Borrowing.book_id)
    )
    if status_filter:
        stmt = stmt.where(Borrowing.status == status_filter)

    rows = db.execute(stmt.order_by(Borrowing.borrowed_at.desc())).all()

    return [
        {
            **borrowing_out(record),
            "student_name": user.full_name,
            "student_email": user.email,
            "student_id": user.student_id,
            "course": user.course,
            "book_title": book.title,
            "book_author": book.author,
            "book_category": book.category,
        }
        for record, user, book in rows
    ]

# =========================================================
# LIBTRACK REQUESTED BOOK CATALOG
# =========================================================

@app.on_event("startup")
def seed_requested_library_books():
    """Restore the original catalog and show only books with credited authors.

    Rows are never physically deleted. Existing books with real authors are
    reactivated, including the original 105-book set. Blank/placeholder-author
    books are hidden from the catalog. IDs, copies, covers, and borrowing history
    remain intact.
    """
    starter_books = [{'title': 'Elements of Literature – Second Edition',
  'author': 'Needs edition/ISBN verification',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': "Glencoe Literature: The Reader's Choice",
  'author': 'Beverly Ann Chin, Denny Wolfe, Jeffrey Copeland, and other contributing authors '
            '(edition-specific; Course 3 catalog record)',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'Glencoe Literature – Course 2',
  'author': 'Needs edition/ISBN verification',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'Glencoe Literature – Course 3',
  'author': 'Needs edition/ISBN verification',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'Glencoe Literature – Course 5',
  'author': 'Needs edition/ISBN verification',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'Glencoe Literature: Texas Treasures – Course 3',
  'author': 'Needs edition/ISBN verification',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'Glencoe Literature: American Literature',
  'author': 'Needs edition/ISBN verification',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'Prentice Hall Literature: Timeless Voices, Timeless Themes',
  'author': 'Various contributing authors and editors; varies by anthology/grade edition',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'Language of Literature',
  'author': 'Needs edition/ISBN verification',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'The Language of Literature – British Literature',
  'author': 'Needs edition/ISBN verification',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'McDougal Littell Literature',
  'author': 'Needs edition/ISBN verification',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'Hot McDougal Literature',
  'author': 'Needs edition/ISBN verification',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'Voices in Literature',
  'author': 'Needs edition/ISBN verification',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'United States in Literature',
  'author': 'Needs edition/ISBN verification',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'World Literature',
  'author': 'Needs edition/ISBN verification',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Philippine Literature',
  'author': 'Needs edition/ISBN verification',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'Early Philippine Literature',
  'author': 'Needs edition/ISBN verification',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'Children and Adolescent Literature',
  'author': 'Jennifer B. Gonzales, Joshlen C. Baclayon, and Jeson A. Bustamante',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'Writing Techniques in English',
  'author': 'Needs edition/ISBN verification',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'Structures of English',
  'author': 'Lelani C. Dapat, Jeromil O. Enoc, Jennifer B. Gonzales, and Dulce B. Anlagan',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'Spanish for Beginners',
  'author': 'Needs edition/ISBN verification',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': "Let's Speak Japanese",
  'author': 'Needs edition/ISBN verification',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'Panitikang Filipino Antolohiya – Binagong Edisyon',
  'author': 'Joey A. Arrogante',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'Wika at Lipunan',
  'author': 'Needs edition/ISBN verification',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'Mythology: Timeless Tales of Gods and Heroes',
  'author': 'Edith Hamilton',
  'category': '1. Literature at Language',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Logic',
  'author': 'Irving M. Copi (common textbook edition; verify title page because several books '
            'share this title)',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Sociology: Focus on the Philippines',
  'author': 'Raymundo',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Fundamentals of Ethics',
  'author': 'Emerita S. Quito',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Ethics',
  'author': 'Needs edition/ISBN verification',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Ethics',
  'author': 'Mariano M. Ariola (2018 edition listed by CSPC; confirm title page)',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Ethics: Principles of Ethical Behavior in Modern Society',
  'author': 'Needs edition/ISBN verification',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'General Psychology – 4th Edition',
  'author': 'Needs edition/ISBN verification',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Personality – Second Edition',
  'author': 'Needs edition/ISBN verification',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to the Humanities',
  'author': 'Needs edition/ISBN verification',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Art Appreciation – 2nd Edition',
  'author': 'Mariano M. Ariola (likely 2nd-edition textbook: Introduction to Art Appreciation; '
            'confirm title page)',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Gender and Society',
  'author': 'Needs edition/ISBN verification',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Exploring Gender and Society',
  'author': 'Needs edition/ISBN verification',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Understanding the Self',
  'author': 'Needs edition/ISBN verification',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'The Art of Self-Discovery and Understanding the Self',
  'author': 'Needs edition/ISBN verification',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Sociology',
  'author': 'Needs edition/ISBN verification',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Society, Culture and Personality: The Social Science Perspectives',
  'author': 'Needs edition/ISBN verification',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Psychological Statistics',
  'author': 'Francisco M. Lambojon (catalogued title; edition needs confirmation)',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Research',
  'author': 'Needs edition/ISBN verification',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Research Writing Made Simple',
  'author': 'Needs edition/ISBN verification',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Science, Technology and Society',
  'author': 'Needs edition/ISBN verification',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'The Story of the Universe',
  'author': 'Needs edition/ISBN verification',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Empowering the Youth for Nation Building',
  'author': 'Needs edition/ISBN verification',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'The Life and Works of Jose Rizal',
  'author': 'Cecilie Sharon T. Porras, Emyline Doctor-C. Salinas, Leah C. Apsay, Maria Janua P. '
            'Cunanan, and John Darrel D. Rillo (2022 Lorimar edition; confirm this is your '
            'edition)',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Values Education',
  'author': 'Needs edition/ISBN verification',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Values Education – Second Edition',
  'author': 'Needs edition/ISBN verification',
  'category': '2. Filipino, Humanities, Psychology at Social Sciences',
  'call_number': None,
  'description': None},
 {'title': 'Physical Education Handbook',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Teaching Strategies and Educational Alternatives – Volume 1',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Measurement and Evaluation',
  'author': 'Calderon',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Study Guide in Logic',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Yellow Book: 1000 Hot LET Questions',
  'author': 'Carl E. Balita',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Assessment in Student Learning',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Assessment in Learning',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Education and the Law',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'The Teacher and the School Curriculum',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Child and Adolescent Development',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Developmental Psychology',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Pregnancy and Child Care',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Child Rearing',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Special Education',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Educational Technology',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Educational and Workplace Readiness Skills',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Teaching Mathematics in the Intermediate Grades',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': "Assessment of Children's Development and Learning",
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'The Teaching Profession',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Building and Enhancing New Literacies Across the Curriculum',
  'author': 'Elmer B. De Leon',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Principles of Teaching',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Principles of Teaching 2',
  'author': 'Lydia N. Agno',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Methods of Teaching',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Handbook on Principles of Teaching',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Elements of Good Teaching',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Teaching and Assessment of the Macroskills',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Teaching Internship',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Teaching Multigrade Classes',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'The Teaching and Assessment of Literature Studies',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Teaching Profession and Applied Ethics',
  'author': 'Needs edition/ISBN verification',
  'category': '3. Education at LET Review',
  'call_number': None,
  'description': None},
 {'title': 'Physical Activity Towards Health and Fitness – PATH-FIT 1',
  'author': 'John Lawrence T. Ambrocio et al. (edition needs confirmation)',
  'category': '4. Physical Education at Health',
  'call_number': None,
  'description': None},
 {'title': 'Physical Activity Towards Health and Fitness – PATH-FIT 2',
  'author': 'Artemio T. Reyes Jr., Bernadette L. Alavazo, Danica G. Betory, John Lery C. '
            'Baclaocos, and Paulo Manuel L. Macapagal',
  'category': '4. Physical Education at Health',
  'call_number': None,
  'description': None},
 {'title': 'Physical Activity Towards Health and Fitness – PATH-FIT 3',
  'author': 'Needs edition/ISBN verification',
  'category': '4. Physical Education at Health',
  'call_number': None,
  'description': None},
 {'title': 'Physical Activity Towards Health and Fitness – PATH-FIT 4',
  'author': 'Needs edition/ISBN verification',
  'category': '4. Physical Education at Health',
  'call_number': None,
  'description': None},
 {'title': 'Pathfit 2: Exercise-Based Fitness Activities',
  'author': 'Meynardo L. Ballecer, Ernesto Thaddeus M. Solmerano, Mark Dexter L. Reyes, and '
            'Rodolfo A. Ignacio',
  'category': '4. Physical Education at Health',
  'call_number': None,
  'description': None},
 {'title': 'Physical Education',
  'author': 'Needs edition/ISBN verification',
  'category': '4. Physical Education at Health',
  'call_number': None,
  'description': None},
 {'title': 'Journey Through the Mind and Body',
  'author': 'Needs edition/ISBN verification',
  'category': '4. Physical Education at Health',
  'call_number': None,
  'description': None},
 {'title': 'World Regional Geography: New Global Order',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Annual Editions: Global Issues 00/01',
  'author': 'Editor varies by annual edition; editor not yet verified',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Annual Editions: Developing World 01/02',
  'author': 'Editor varies by annual edition; editor not yet verified',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Annual Editions: American History, Volume II – 16th Edition',
  'author': 'Editor varies by annual edition; editor not yet verified',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'World History',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Why We Remember',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Let Freedom Ring',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'World History: The Human Experience',
  'author': 'Roger B. Beck, Linda Black, Larry S. Krieger, Phillip C. Naylor, and Dahia Ibo '
            'Shabaka (McGraw-Hill edition; confirm edition)',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'American History: The Modern Era Since 1865',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Across the Centuries',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'The American Experience',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'History of Asian Nations',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Journal of Asian History',
  'author': 'Contributors vary by issue; no single book author',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Modern China',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'China Today',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Korea Newsreview',
  'author': 'Korea Newsreview editorial staff (periodical; article authors vary by issue)',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'The Bangladesh Development Studies',
  'author': 'Bangladesh Institute of Development Studies (institutional publisher; article authors '
            'vary by issue)',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Pakistan Digest',
  'author': 'Pakistan Digest editorial staff (periodical; article authors vary by issue)',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'American Sailing Ships',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'The Unfinished Nation: A Concise History of the American People',
  'author': 'Alan Brinkley',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'The Revolution of the Masses',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'A Nation on Fire',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'This Great Nation',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'American Government',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': "People's Economy",
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'History from the People (Kasaysayan mula sa Bayan)',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Kasaysayan ng Daigdig',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Kasaysayan ng Pilipinas',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Asya: Heograpiya, Kasaysayan at Kultura',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Ang Mga Hapones',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Alala ng Seda at Dayami',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'A History of the Inarticulate',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'The Filipino and the History of Asian Nations',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': "Youth in Today's World: Asia and Africa",
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Filipino Legacy in Australia',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Curriculum Development in the Philippines Setting',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'EBC and ASEAN: The Regional Community Experience',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Consuming Passions: Philippine Popular Culture',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Huk: Philippine Agrarian Society in Revolt',
  'author': 'Benedict J. Kerkvliet',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Understanding Contemporary China',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Fruits and Politics of Shared Power',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Urban Society – 10th Edition',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Interracial America',
  'author': 'Needs edition/ISBN verification',
  'category': '5. History, Geography at Political Science',
  'call_number': None,
  'description': None},
 {'title': 'Fundamentals of Management',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Financial Management',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Management Science',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Safety Management',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Management of Organizations',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Production Management',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Supply Chain and Logistics Management',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Total Quality Management',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Strategic Business Analysis with Management',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Strategic Management',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Advanced Human Resource Management',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Advanced Marketing Management',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Advanced Production and Operations Management',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Marketing Management',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Marketing Concepts and Organization',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Entrepreneurship',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Internet Marketing',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Business-to-Business Marketing',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Financial Analysis and Reporting',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Macroeconomics',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Pricing Strategy',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Understanding Marketing Research',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'International Business and Trade',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Regional Integration and Development',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Business Mathematics – Third Edition',
  'author': 'Winston S. Sirug',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Business Mathematics – Fourth Edition',
  'author': 'Winston S. Sirug',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Mathematics of Investment',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Macroeconomics: An Introduction',
  'author': 'Carlos L. Manapat',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Accounting Principles',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'The Accounting Process',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Accounting',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Intermediate Accounting',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'International Financial Statistics',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Auditing and Assurance Services – Second Edition',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Operations Management',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Accounting for Governmental and Nonprofit Entities',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Applied Auditing',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Financial Management and Analysis',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Philippine Investments',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Income Taxation',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'The Productivity Prescription',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Financial Accounting',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Cost Accounting',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Management Accounting',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Transfer and Business Taxation Made Easy',
  'author': 'Susan Ballada and Winifred Lu Ballada',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Modular Activities in Principles of Tourism',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Quantitative Techniques for Business',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Project Management',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Microeconomics – Second Edition',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Business Policy and Strategic Management',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Business Ethics',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Finance Officers Guide',
  'author': 'Needs edition/ISBN verification',
  'category': '6. Business, Management at Economics',
  'call_number': None,
  'description': None},
 {'title': 'Labor Laws Source Book – 4th Edition (2003)',
  'author': 'Needs edition/ISBN verification',
  'category': '7. Law, Labor at Government',
  'call_number': None,
  'description': None},
 {'title': 'Summary of 1989 Supreme Court Rulings',
  'author': 'Needs edition/ISBN verification',
  'category': '7. Law, Labor at Government',
  'call_number': None,
  'description': None},
 {'title': 'Martinez Summary of Supreme Court Rulings – July–December 1991',
  'author': 'Needs edition/ISBN verification',
  'category': '7. Law, Labor at Government',
  'call_number': None,
  'description': None},
 {'title': 'Martinez Summary of Supreme Court Rulings – January–June 1991',
  'author': 'Needs edition/ISBN verification',
  'category': '7. Law, Labor at Government',
  'call_number': None,
  'description': None},
 {'title': 'The Labor Code with Comments and Cases – Revised Edition',
  'author': 'Needs edition/ISBN verification',
  'category': '7. Law, Labor at Government',
  'call_number': None,
  'description': None},
 {'title': 'Law for Business',
  'author': 'Needs edition/ISBN verification',
  'category': '7. Law, Labor at Government',
  'call_number': None,
  'description': None},
 {'title': 'Law for Business – Seventh Edition',
  'author': 'Needs edition/ISBN verification',
  'category': '7. Law, Labor at Government',
  'call_number': None,
  'description': None},
 {'title': 'Employment Law for Business',
  'author': 'Needs edition/ISBN verification',
  'category': '7. Law, Labor at Government',
  'call_number': None,
  'description': None},
 {'title': 'The Effective Executive',
  'author': 'Peter F. Drucker',
  'category': '7. Law, Labor at Government',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Scala Programming',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Information Assurance and Security',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Information Assurance and Security – Book 1',
  'author': 'Jake R. Pomperada and Jason V. Castellano',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Information Assurance and Security – Book 2',
  'author': 'Jake R. Pomperada and Jason V. Castellano',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Living in the Information Technology Era',
  'author': 'Ronina R. Caoili-Tayuan and Mia V. Eleazar (C&E edition); Teodoro F. Revano Jr. '
            '(Mindshapers edition)',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Computer-Aided Drafting Using AutoCAD',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Information Systems',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'HTML5 and CSS3: Introductory',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Data Structures',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Fundamentals of Python Programming',
  'author': 'Jake Rodriguez Pomperada, Rollyn M. Moises, and Sunday Vince V. Latergo',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to C Programming',
  'author': 'Jake Rodriguez Pomperada and Kristine T. Soberano',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Web Application Programming',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Application Development and Emerging Technologies',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Cybersecurity',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Software Engineering',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Database Systems',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Database Systems Using Microsoft Access',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'MySQL',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': "Beginner's Guide to C++ Programming",
  'author': 'Jake Rodriguez Pomperada',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'AngularJS Programming for Beginners',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Understanding Programming for Beginners Using C#',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Outcomes-Based Practical Guide to Thesis and Capstone Project',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Information Systems Fundamentals',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Database Using Microsoft Access',
  'author': 'Dean Marmelo V. Abante, Myra S. J. Santos, John Edgar S. Anthony, Jedric Jgabe B. '
            'Santos, Mark Raffy M. Neones, Catherine R. Delfin, and Dan Michael A. Cortez',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Ruby Programming',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Computer Programming',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Perl Programming',
  'author': 'Jake Rodriguez Pomperada',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Go Programming',
  'author': 'Jake R. Pomperada',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Discrete Mathematics',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Web Programming Using PHP and MySQL',
  'author': 'Haley V. Lampawog and Jake R. Pomperada',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Computer Programming with Java',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Python Programming',
  'author': 'Needs edition/ISBN verification',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to jQuery Programming',
  'author': 'Jake Rodriguez Pomperada and Frederick O. Villaluna',
  'category': '8. Information Technology at Computer Science',
  'call_number': None,
  'description': None},
 {'title': 'The New Book of Knowledge – Volumes 1–21',
  'author': 'Grolier Incorporated (encyclopedia/editorial publisher; individual volume editors '
            'vary)',
  'category': '9. Encyclopedia at Reference Books',
  'call_number': None,
  'description': None},
 {'title': 'Grolier Encyclopedia of Knowledge – Volumes 1–20',
  'author': 'Grolier Incorporated (encyclopedia/editorial publisher; individual volume editors '
            'vary)',
  'category': '9. Encyclopedia at Reference Books',
  'call_number': None,
  'description': None},
 {'title': 'Grolier Business Library – Volumes 1–10',
  'author': 'Grolier Incorporated (corporate/editorial author; edition-specific editors need '
            'confirmation)',
  'category': '9. Encyclopedia at Reference Books',
  'call_number': None,
  'description': None},
 {'title': 'Encyclopedia Britannica – Volumes at Text Index',
  'author': 'Encyclopaedia Britannica, Inc. (editorial organization)',
  'category': '9. Encyclopedia at Reference Books',
  'call_number': None,
  'description': None},
 {'title': 'Lexicon Universal Encyclopedia',
  'author': 'Needs edition/ISBN verification',
  'category': '9. Encyclopedia at Reference Books',
  'call_number': None,
  'description': None},
 {'title': 'Do-It-Yourself Encyclopedia',
  'author': 'Needs edition/ISBN verification',
  'category': '9. Encyclopedia at Reference Books',
  'call_number': None,
  'description': None},
 {'title': "21st Century Webster's International Encyclopedia – First Edition",
  'author': 'Needs edition/ISBN verification',
  'category': '9. Encyclopedia at Reference Books',
  'call_number': None,
  'description': None},
 {'title': "The Official Webster's English-Filipino Dictionary with Thesaurus",
  'author': 'Needs edition/ISBN verification',
  'category': '9. Encyclopedia at Reference Books',
  'call_number': None,
  'description': None},
 {'title': 'The World Almanac 2024',
  'author': 'Needs edition/ISBN verification',
  'category': '9. Encyclopedia at Reference Books',
  'call_number': None,
  'description': None},
 {'title': "Ripley's Believe It or Not! 2024",
  'author': 'Ripley Entertainment Inc. / Ripley Publishing (corporate author; edition-specific '
            'editor needs confirmation)',
  'category': '9. Encyclopedia at Reference Books',
  'call_number': None,
  'description': None},
 {'title': 'National Geographic Magazine – Various Monthly Issues (including 1991 issues)',
  'author': 'Needs edition/ISBN verification',
  'category': '9. Encyclopedia at Reference Books',
  'call_number': None,
  'description': None},
 {'title': 'The Economist',
  'author': 'The Economist editorial staff (individual article authors vary by issue)',
  'category': '9. Encyclopedia at Reference Books',
  'call_number': None,
  'description': None},
 {'title': 'Annual Editions Series',
  'author': 'Needs edition/ISBN verification',
  'category': '9. Encyclopedia at Reference Books',
  'call_number': None,
  'description': None},
 {'title': 'Encyclopedia/Reference Volumes',
  'author': 'Needs edition/ISBN verification',
  'category': '9. Encyclopedia at Reference Books',
  'call_number': None,
  'description': None},
 {'title': 'Modern Medical Guide',
  'author': 'Needs edition/ISBN verification',
  'category': '10. Medical, Health at Science',
  'call_number': None,
  'description': None},
 {'title': 'Choosing Health and Wellness',
  'author': 'Needs edition/ISBN verification',
  'category': '10. Medical, Health at Science',
  'call_number': None,
  'description': None},
 {'title': 'Brief Core Concepts in Health',
  'author': 'Needs edition/ISBN verification',
  'category': '10. Medical, Health at Science',
  'call_number': None,
  'description': None},
 {'title': 'Dental Hygiene',
  'author': 'Needs edition/ISBN verification',
  'category': '10. Medical, Health at Science',
  'call_number': None,
  'description': None},
 {'title': 'The Para Handbook of Medical Records',
  'author': 'Needs edition/ISBN verification',
  'category': '10. Medical, Health at Science',
  'call_number': None,
  'description': None},
 {'title': 'Chinese University Bulletin: Professional Inaugural Lecture Series No. 6–10',
  'author': 'The Chinese University of Hong Kong (institutional author; lecturer varies by issue)',
  'category': '10. Medical, Health at Science',
  'call_number': None,
  'description': None},
 {'title': '10 SATs: The Actual and Complete Scholastic Aptitude Test Plus Advice from the College Board on How to Prepare for It',
  'author': 'College Entrance Examination Board',
  'category': '10. Medical, Health at Science',
  'call_number': None,
  'description': None},
 {'title': 'Transportation',
  'author': 'Needs edition/ISBN verification',
  'category': '10. Medical, Health at Science',
  'call_number': None,
  'description': None},
 {'title': 'Design of Machinery – Second Edition',
  'author': 'Robert L. Norton',
  'category': '10. Medical, Health at Science',
  'call_number': None,
  'description': None},
 {'title': 'Particulate and Fracture Mechanics – Volume 2',
  'author': 'Needs edition/ISBN verification',
  'category': '10. Medical, Health at Science',
  'call_number': None,
  'description': None},
 {'title': 'Information on Fatigue and Fatigue Testing and Analysis',
  'author': 'Needs edition/ISBN verification',
  'category': '10. Medical, Health at Science',
  'call_number': None,
  'description': None},
 {'title': 'Hands-on Networking Fundamentals',
  'author': 'Needs edition/ISBN verification',
  'category': '11. Computer Science at Engineering',
  'call_number': None,
  'description': None},
 {'title': 'Easy Upgrading and Troubleshooting',
  'author': 'Needs edition/ISBN verification',
  'category': '11. Computer Science at Engineering',
  'call_number': None,
  'description': None},
 {'title': 'Fundamentals of Software Engineering',
  'author': 'Needs edition/ISBN verification',
  'category': '11. Computer Science at Engineering',
  'call_number': None,
  'description': None},
 {'title': 'Introduction to Computer Networking',
  'author': 'Jake R. Pomperada and Dino L. Ilustrisimo',
  'category': '11. Computer Science at Engineering',
  'call_number': None,
  'description': None},
 {'title': 'Java: Data Structures and Algorithms',
  'author': 'Needs edition/ISBN verification',
  'category': '11. Computer Science at Engineering',
  'call_number': None,
  'description': None},
 {'title': 'Concepts of Database Management',
  'author': 'Joan C. Coronel and Steven Morris (edition-dependent; verify title page)',
  'category': '11. Computer Science at Engineering',
  'call_number': None,
  'description': None},
 {'title': 'Systems Analysis and Design Methods – Fourth Edition',
  'author': 'Jeffrey L. Whitten, Lonnie D. Bentley, and Kevin C. Dittman',
  'category': '11. Computer Science at Engineering',
  'call_number': None,
  'description': None},
 {'title': 'Dummies 101: Windows',
  'author': 'Andy Rathbone (edition-dependent; verify title page)',
  'category': '11. Computer Science at Engineering',
  'call_number': None,
  'description': None},
 {'title': 'Software Engineering',
  'author': 'Needs edition/ISBN verification',
  'category': '11. Computer Science at Engineering',
  'call_number': None,
  'description': None},
 {'title': 'Multimodal Imaging and Deformation Testing Techniques',
  'author': 'Needs edition/ISBN verification',
  'category': '11. Computer Science at Engineering',
  'call_number': None,
  'description': None},
 {'title': 'Asian Development Bank: Annual Report 2001',
  'author': 'Asian Development Bank (institutional author)',
  'category': '12. Iba pang Books at Reports',
  'call_number': None,
  'description': None},
 {'title': 'Asian Development Bank: Annual Report 2004',
  'author': 'Asian Development Bank (institutional author)',
  'category': '12. Iba pang Books at Reports',
  'call_number': None,
  'description': None},
 {'title': 'Asian Development Bank: Annual Report 2003',
  'author': 'Asian Development Bank (institutional author)',
  'category': '12. Iba pang Books at Reports',
  'call_number': None,
  'description': None},
 {'title': 'Philippine Tourism',
  'author': 'Needs edition/ISBN verification',
  'category': '12. Iba pang Books at Reports',
  'call_number': None,
  'description': None},
 {'title': 'The Political Economy of Asia',
  'author': 'Needs edition/ISBN verification',
  'category': '12. Iba pang Books at Reports',
  'call_number': None,
  'description': None},
 {'title': 'General Sociology',
  'author': 'Needs edition/ISBN verification',
  'category': '12. Iba pang Books at Reports',
  'call_number': None,
  'description': None},
 {'title': 'Principles of Teaching and Learning',
  'author': 'Needs edition/ISBN verification',
  'category': '12. Iba pang Books at Reports',
  'call_number': None,
  'description': None},
 {'title': 'Technology for Teaching and Learning 2',
  'author': 'Needs edition/ISBN verification',
  'category': '12. Iba pang Books at Reports',
  'call_number': None,
  'description': None}]

    # Authors researched against the exact titles supplied for the LibTrack catalog.
    # Edition-ambiguous titles are intentionally left for confirmation instead of guessed.
    verified_authors = {'Sociology: Focus on the Philippines': 'Isabel S. Panopio and Adelisa A. Raymundo', 'Fundamentals of Ethics': 'Emerita S. Quito', 'General Psychology – 4th Edition': 'Alicia H. Kahayon and Gaudencio V. Aquino', 'Measurement and Evaluation – Calderon': 'Jose F. Calderon and Expectacion C. Gonzales', 'Panitikang Filipino Antolohiya – Binagong Edisyon': 'Joey A. Arrogante', 'Children and Adolescent Literature': 'Jennifer B. Gonzales, Joshlen C. Baclayon, and Jeson A. Bustamante', 'PATHFIT 2: Exercise-Based Fitness Activities': 'Meynardo L. Ballecer, Ernesto Thaddeus M. Solmerano, Mark Dexter L. Reyes, and Rodolfo A. Ignacio', 'The Unfinished Nation: A Concise History of the American People': 'Alan Brinkley', 'Information Assurance and Security – Book 1': 'Jake R. Pomperada and Jason V. Castellano', 'Information Assurance and Security – Book 2': 'Jake R. Pomperada and Jason V. Castellano', 'Introduction to Database Using Microsoft Access': 'Dean Marmelo V. Abante, Myra S. J. Santos, John Edgar S. Anthony, Jedric Jgabe B. Santos, Mark Raffy M. Neones, Catherine R. Delfin, and Dan Michael A. Cortez', 'Introduction to jQuery Programming': 'Jake R. Pomperada and Frederick O. Villaluna', 'Introduction to Perl Programming': 'Jake Rodriguez Pomperada', 'Fundamentals of Python Programming': 'Jake R. Pomperada', 'Business Mathematics – Third Edition': 'Winston S. Sirug (Business Mathematics: A Practical Approach, Third Edition; confirm subtitle on copy)'}
    for catalog_book in starter_books:
        researched_author = verified_authors.get(catalog_book["title"])
        if researched_author:
            catalog_book["author"] = researched_author

    with SessionLocal() as db:
        existing_books = db.scalars(select(Book)).all()

        # Update Book #345 in place: keep its ID, copies, cover, call number,
        # description, and borrowing relationships while correcting its title and author.
        book_345 = next((book for book in existing_books if book.id == 345), None)
        if book_345 is not None:
            book_345.title = '10 SATs: The Actual and Complete Scholastic Aptitude Test Plus Advice from the College Board on How to Prepare for It'
            book_345.author = 'College Entrance Examination Board'
            book_345.is_active = True

        existing_by_title = {
            (book.title or "").strip().casefold(): book
            for book in existing_books
        }

        # Restore the earlier catalog entries (including the original 105-book set)
        # whenever their records contain a real author. Keep all database rows and
        # borrowing history; only hide books with blank/placeholder author values.
        for book in existing_books:
            book.is_active = has_real_book_author(book.author)

        added = 0
        updated = 0
        for item in starter_books:
            key = item["title"].strip().casefold()
            existing = existing_by_title.get(key)

            if existing:
                existing.category = item["category"]
                # Apply source-researched authors for these exact supplied titles.
                # For other titles, do not replace an existing known author with a placeholder.
                if item["title"] in verified_authors:
                    existing.author = item["author"]
                elif not has_real_book_author(existing.author) and has_real_book_author(item.get("author")):
                    # Restore a known author from the original catalog when the current
                    # database contains only a blank or placeholder value.
                    existing.author = item["author"]
                # Decide visibility from the final author value, preserving a known
                # existing author when the supplied catalog only has a placeholder.
                existing.is_active = has_real_book_author(existing.author)
                # Keep existing call numbers, descriptions, covers, and copy counts.
                updated += 1
                continue

            db.add(Book(
                title=item["title"],
                author=item["author"],
                category=item["category"],
                call_number=item["call_number"],
                description=item["description"],
                total_copies=1,
                available_copies=1,
                is_active=has_real_book_author(item.get("author")),
            ))
            added += 1

        # Apply a one-time, balanced 1/2/3-copy distribution to every active
        # catalog book. A SystemSetting marker prevents the distribution from
        # being reassigned every time the API restarts.
        db.flush()
        distribution_setting_key = "book_copy_distribution_v1"
        distribution_setting = db.get(SystemSetting, distribution_setting_key)

        if distribution_setting is None:
            active_books = db.scalars(
                select(Book).where(Book.is_active.is_(True)).order_by(Book.id.asc())
            ).all()

            borrowed_counts_rows = db.query(
                Borrowing.book_id, func.count(Borrowing.id)
            ).filter(
                Borrowing.status == "borrowed",
                Borrowing.returned_at.is_(None),
            ).group_by(Borrowing.book_id).all()
            borrowed_counts = {
                book_id: int(count)
                for book_id, count in borrowed_counts_rows
            }

            # The three target quantities are distributed as evenly as
            # possible, then shuffled deterministically across book IDs.
            copy_targets = [1, 2, 3] * (len(active_books) // 3)
            copy_targets.extend([1, 2, 3][:len(active_books) % 3])
            random.Random(20261115).shuffle(copy_targets)

            final_distribution = {1: 0, 2: 0, 3: 0}
            protected_books = 0

            for book, target_copies in zip(active_books, copy_targets):
                # Protect already-borrowed copies. Use both the inventory
                # balance and active borrowing records so no live loan is
                # accidentally removed from the book's total inventory.
                inventory_borrowed = max(
                    0,
                    int(book.total_copies or 0) - int(book.available_copies or 0),
                )
                recorded_borrowed = borrowed_counts.get(book.id, 0)
                borrowed_copies = max(inventory_borrowed, recorded_borrowed)
                assigned_total = max(target_copies, borrowed_copies)

                book.total_copies = assigned_total
                book.available_copies = assigned_total - borrowed_copies

                final_distribution[assigned_total] = final_distribution.get(assigned_total, 0) + 1
                if assigned_total > target_copies:
                    protected_books += 1

            db.add(SystemSetting(
                key=distribution_setting_key,
                value=json.dumps({
                    "applied": True,
                    "active_books": len(active_books),
                    "distribution": final_distribution,
                    "protected_books": protected_books,
                    "targets": [1, 2, 3],
                }),
            ))
            print(
                "LibTrack book-copy distribution applied: "
                f"1 copy={final_distribution.get(1, 0)}, "
                f"2 copies={final_distribution.get(2, 0)}, "
                f"3 copies={final_distribution.get(3, 0)}, "
                f"protected books={protected_books}."
            )

        db.commit()
        print(
            f"LibTrack catalog ready: {len(starter_books)} requested titles "
            f"({added} added, {updated} reactivated/updated)."
        )
