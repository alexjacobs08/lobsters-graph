"""Database schema and helpers for lobsters-graph."""

import sqlite3
from pathlib import Path
from contextlib import contextmanager

DB_PATH = Path(__file__).parent.parent / "data" / "users.db"


def get_connection():
    """Get a database connection."""
    return sqlite3.connect(DB_PATH)


@contextmanager
def get_cursor():
    """Context manager for database cursor."""
    conn = get_connection()
    conn.row_factory = sqlite3.Row
    try:
        yield conn.cursor()
        conn.commit()
    finally:
        conn.close()


def init_db():
    """Initialize the database schema."""
    with get_cursor() as cur:
        # Users table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                karma INTEGER,
                about TEXT,
                created_at TEXT,
                invited_by_username TEXT,
                github_username TEXT,
                twitter_username TEXT,
                website TEXT,
                scraped_at TEXT,
                FOREIGN KEY (invited_by_username) REFERENCES users(username)
            )
        """)

        # Enrichment data from Exa
        cur.execute("""
            CREATE TABLE IF NOT EXISTS enrichment (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                full_name TEXT,
                linkedin_url TEXT,
                github_url TEXT,
                twitter_url TEXT,
                company TEXT,
                title TEXT,
                location TEXT,
                bio TEXT,
                other_urls TEXT,  -- JSON array
                raw_response TEXT,  -- Full Exa response
                enriched_at TEXT,
                FOREIGN KEY (username) REFERENCES users(username)
            )
        """)

        # Indexes for common queries
        cur.execute("CREATE INDEX IF NOT EXISTS idx_invited_by ON users(invited_by_username)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_karma ON users(karma)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_created ON users(created_at)")

    print(f"Database initialized at {DB_PATH}")


def upsert_user(username, karma=None, about=None, created_at=None,
                invited_by_username=None, github_username=None,
                twitter_username=None, website=None, scraped_at=None):
    """Insert or update a user."""
    with get_cursor() as cur:
        cur.execute("""
            INSERT INTO users (username, karma, about, created_at, invited_by_username,
                             github_username, twitter_username, website, scraped_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
                karma = COALESCE(excluded.karma, karma),
                about = COALESCE(excluded.about, about),
                created_at = COALESCE(excluded.created_at, created_at),
                invited_by_username = COALESCE(excluded.invited_by_username, invited_by_username),
                github_username = COALESCE(excluded.github_username, github_username),
                twitter_username = COALESCE(excluded.twitter_username, twitter_username),
                website = COALESCE(excluded.website, website),
                scraped_at = COALESCE(excluded.scraped_at, scraped_at)
        """, (username, karma, about, created_at, invited_by_username,
              github_username, twitter_username, website, scraped_at))


def get_user(username):
    """Get a user by username."""
    with get_cursor() as cur:
        cur.execute("SELECT * FROM users WHERE username = ?", (username,))
        return cur.fetchone()


def get_all_users():
    """Get all users."""
    with get_cursor() as cur:
        cur.execute("SELECT * FROM users ORDER BY karma DESC")
        return cur.fetchall()


def get_users_for_enrichment():
    """Get users that have enrichable data but haven't been enriched yet."""
    with get_cursor() as cur:
        cur.execute("""
            SELECT u.* FROM users u
            LEFT JOIN enrichment e ON u.username = e.username
            WHERE e.id IS NULL
            AND (u.about IS NOT NULL AND u.about != ''
                 OR u.github_username IS NOT NULL
                 OR u.twitter_username IS NOT NULL
                 OR u.website IS NOT NULL)
            ORDER BY u.karma DESC
        """)
        return cur.fetchall()


def get_invitation_tree():
    """Get the invitation tree as edges."""
    with get_cursor() as cur:
        cur.execute("""
            SELECT u.username as invitee, u.invited_by_username as inviter
            FROM users u
            WHERE u.invited_by_username IS NOT NULL
        """)
        return cur.fetchall()


if __name__ == "__main__":
    init_db()
