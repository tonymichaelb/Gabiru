"""
Simple user database using JSON file storage.
For production, consider using SQLite or PostgreSQL.
"""
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Optional

from app.auth import User, get_password_hash, verify_password


# Database file location
DB_DIR = Path(__file__).parent.parent / "data"
DB_FILE = DB_DIR / "users.json"


def _ensure_db_exists():
    """Ensure database directory and file exist."""
    DB_DIR.mkdir(parents=True, exist_ok=True)
    if not DB_FILE.exists():
        DB_FILE.write_text("{}")


def _load_users() -> dict:
    """Load users from JSON file."""
    _ensure_db_exists()
    try:
        return json.loads(DB_FILE.read_text())
    except (json.JSONDecodeError, FileNotFoundError):
        return {}


def _save_users(users: dict):
    """Save users to JSON file."""
    _ensure_db_exists()
    DB_FILE.write_text(json.dumps(users, indent=2))


def has_users() -> bool:
    """Check if any users exist in the database."""
    users = _load_users()
    return len(users) > 0


def get_user(username: str) -> Optional[User]:
    """Get user by username."""
    users = _load_users()
    user_data = users.get(username)
    if user_data:
        return User(**user_data)
    return None


def create_user(username: str, password: str) -> User:
    """Create a new user."""
    users = _load_users()
    
    if username in users:
        raise ValueError("Usuário já existe")
    
    user = User(
        username=username,
        hashed_password=get_password_hash(password),
        created_at=datetime.utcnow().isoformat()
    )
    
    users[username] = user.model_dump()
    _save_users(users)
    
    return user


def authenticate_user(username: str, password: str) -> Optional[User]:
    """Authenticate user with username and password."""
    user = get_user(username)
    if not user:
        return None
    if not verify_password(password, user.hashed_password):
        return None
    return user


def change_password(username: str, current_password: str, new_password: str) -> None:
    """Change password for an existing user (requires current password)."""
    users = _load_users()
    user_data = users.get(username)
    if not user_data:
        raise ValueError("Usuário não existe")

    user = User(**user_data)
    if not verify_password(current_password, user.hashed_password):
        raise ValueError("Senha atual incorreta")

    user.hashed_password = get_password_hash(new_password)
    users[username] = user.model_dump()
    _save_users(users)


def reset_users() -> None:
    """Delete all users (DEV/maintenance operation)."""
    _ensure_db_exists()
    DB_FILE.write_text("{}")
