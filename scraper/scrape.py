"""Scraper for lobste.rs user data."""

import re
import time
import random
from datetime import datetime
from pathlib import Path
from bs4 import BeautifulSoup
import requests

from db import init_db, upsert_user, get_user

# Be respectful - lobste.rs rate limits aggressively
BASE_URL = "https://lobste.rs"
REQUEST_DELAY = 1.5  # seconds between requests
MAX_RETRIES = 3
RETRY_BACKOFF = 5  # seconds, doubles each retry

HEADERS = {
    "User-Agent": "lobsters-graph-research/1.0 (building user invitation graph visualization)",
    "Accept": "text/html,application/xhtml+xml",
}


def parse_user_list_page(html):
    """
    Parse the /users page HTML to extract usernames.
    Returns list of usernames found on the page.
    """
    soup = BeautifulSoup(html, "html.parser")
    usernames = []

    # Users page has links like /u/username or /~username
    for link in soup.find_all("a", href=True):
        href = link["href"]
        # Match /u/username or /~username patterns
        match = re.match(r"^/(?:u/|~)([a-zA-Z0-9_-]+)$", href)
        if match:
            usernames.append(match.group(1))

    return list(set(usernames))  # dedupe


def parse_user_profile(html, username):
    """
    Parse a user profile page HTML.
    Returns dict with user data.
    """
    soup = BeautifulSoup(html, "html.parser")
    data = {"username": username}

    # Look for karma - usually in a format like "1234 karma"
    karma_match = soup.find(string=re.compile(r"\d+\s*karma", re.I))
    if karma_match:
        karma_num = re.search(r"(\d+)", karma_match)
        if karma_num:
            data["karma"] = int(karma_num.group(1))

    # Look for "member since" or join date
    member_since = soup.find(string=re.compile(r"member\s+(?:since|for)", re.I))
    if member_since:
        # Try to find a date nearby
        parent = member_since.parent if member_since.parent else None
        if parent:
            date_match = re.search(r"(\d{4}-\d{2}-\d{2})", parent.get_text())
            if date_match:
                data["created_at"] = date_match.group(1)

    # Look for "invited by" link
    invited_by_link = soup.find("a", href=re.compile(r"^/(?:u/|~)"), string=re.compile(r".+"))
    # More specific: look for text containing "invited by"
    invited_section = soup.find(string=re.compile(r"invited\s+by", re.I))
    if invited_section:
        parent = invited_section.parent if invited_section.parent else None
        if parent:
            inviter_link = parent.find("a", href=re.compile(r"^/(?:u/|~)"))
            if inviter_link:
                inviter_match = re.match(r"^/(?:u/|~)([a-zA-Z0-9_-]+)", inviter_link["href"])
                if inviter_match:
                    data["invited_by_username"] = inviter_match.group(1)

    # Look for about/bio section
    about_section = soup.find(class_=re.compile(r"about|bio", re.I))
    if about_section:
        data["about"] = about_section.get_text(strip=True)

    # Extract links - GitHub, Twitter, website
    for link in soup.find_all("a", href=True):
        href = link["href"]

        # GitHub
        gh_match = re.match(r"https?://(?:www\.)?github\.com/([a-zA-Z0-9_-]+)/?$", href)
        if gh_match:
            data["github_username"] = gh_match.group(1)

        # Twitter/X
        tw_match = re.match(r"https?://(?:www\.)?(?:twitter|x)\.com/([a-zA-Z0-9_]+)/?$", href)
        if tw_match:
            data["twitter_username"] = tw_match.group(1)

        # Personal website (heuristic: not a known platform)
        if (href.startswith("http") and
            not any(domain in href for domain in [
                "github.com", "twitter.com", "x.com", "linkedin.com",
                "lobste.rs", "reddit.com", "news.ycombinator.com"
            ])):
            # Likely a personal website
            if "website" not in data:
                data["website"] = href

    data["scraped_at"] = datetime.utcnow().isoformat()
    return data


def fetch_with_retry(url):
    """Fetch URL with retry logic and rate limiting."""
    for attempt in range(MAX_RETRIES):
        try:
            time.sleep(REQUEST_DELAY + random.uniform(0, 0.5))
            response = requests.get(url, headers=HEADERS, timeout=30)

            if response.status_code == 200:
                return response.text
            elif response.status_code == 429:
                # Rate limited - back off
                backoff = RETRY_BACKOFF * (2 ** attempt)
                print(f"Rate limited, waiting {backoff}s...")
                time.sleep(backoff)
            else:
                print(f"HTTP {response.status_code} for {url}")
                return None

        except requests.RequestException as e:
            print(f"Request error: {e}")
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BACKOFF * (2 ** attempt))

    return None


def scrape_user(username):
    """Scrape a single user profile."""
    url = f"{BASE_URL}/~{username}"
    html = fetch_with_retry(url)
    if html:
        return parse_user_profile(html, username)
    return None


def scrape_users_from_html_file(filepath):
    """
    Load user list from a saved HTML file.
    Use this when rate-limited - save the page manually and parse it.
    """
    with open(filepath, "r", encoding="utf-8") as f:
        html = f.read()
    return parse_user_list_page(html)


def main():
    """Main scraping loop."""
    init_db()

    # Check for local HTML file first
    local_users_html = Path(__file__).parent.parent / "data" / "users_page.html"

    if local_users_html.exists():
        print(f"Loading users from {local_users_html}")
        usernames = scrape_users_from_html_file(local_users_html)
    else:
        print("No local users_page.html found.")
        print(f"Save the lobste.rs/users page HTML to: {local_users_html}")
        print("Then run this script again.")
        return

    print(f"Found {len(usernames)} usernames")

    # Scrape each user
    for i, username in enumerate(usernames):
        # Skip if already scraped
        existing = get_user(username)
        if existing and existing["scraped_at"]:
            print(f"[{i+1}/{len(usernames)}] Skipping {username} (already scraped)")
            continue

        print(f"[{i+1}/{len(usernames)}] Scraping {username}...")
        user_data = scrape_user(username)

        if user_data:
            upsert_user(**user_data)
            print(f"  -> karma={user_data.get('karma')}, invited_by={user_data.get('invited_by_username')}")
        else:
            # Still record the username even if scrape failed
            upsert_user(username=username)
            print(f"  -> Failed to scrape")


if __name__ == "__main__":
    main()
