"""Enrich user data using Exa people search API."""

import os
import json
import time
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from exa_py import Exa

# Load .env from project root
load_dotenv(Path(__file__).parent.parent / ".env")

from db import init_db, get_users_for_enrichment, get_cursor

# Rate limit for Exa API
REQUEST_DELAY = 0.5  # seconds


def build_search_query(user):
    """
    Build a search query for Exa based on available user data.
    Returns None if not enough data to search.
    """
    parts = []

    # Username might be a real name or handle
    username = user["username"]

    # Check about/bio for a real name
    about = user["about"] or ""

    # If we have a GitHub username, that's valuable
    if user["github_username"]:
        parts.append(f"github.com/{user['github_username']}")

    # Twitter username
    if user["twitter_username"]:
        parts.append(f"@{user['twitter_username']}")

    # Personal website
    if user["website"]:
        parts.append(user["website"])

    # If no external links, try to find identifying info in bio
    if not parts:
        # Look for patterns that suggest a real name in the about
        # Skip if bio is too short or generic
        if len(about) < 20:
            return None

        # Use username + bio snippet as query
        bio_snippet = about[:100].replace("\n", " ")
        parts.append(f"{username} {bio_snippet}")

    # Combine parts
    query = " ".join(parts)

    # Add "software engineer" or "developer" to help with context
    # if we don't have much to go on
    if len(parts) == 1 and not any(x in query.lower() for x in ["github", "twitter", "@"]):
        query += " software engineer developer"

    return query


def enrich_user(exa_client, user):
    """
    Search for additional info about a user using Exa.
    Returns enrichment dict or None.
    """
    query = build_search_query(user)
    if not query:
        return None

    try:
        # Use Exa people search
        results = exa_client.search(
            query,
            type="auto",
            category="people",
            num_results=5,
            use_autoprompt=True,
        )

        if not results.results:
            return None

        # Parse results to extract structured data
        enrichment = {
            "username": user["username"],
            "full_name": None,
            "linkedin_url": None,
            "github_url": None,
            "twitter_url": None,
            "company": None,
            "title": None,
            "location": None,
            "bio": None,
            "other_urls": [],
            "raw_response": json.dumps([r.__dict__ for r in results.results], default=str),
            "enriched_at": datetime.utcnow().isoformat(),
        }

        for result in results.results:
            url = result.url.lower()
            title = result.title or ""

            # LinkedIn
            if "linkedin.com/in/" in url and not enrichment["linkedin_url"]:
                enrichment["linkedin_url"] = result.url
                # Try to extract name from LinkedIn title
                # Format: "Name - Title - Company | LinkedIn"
                if " - " in title:
                    name_part = title.split(" - ")[0].strip()
                    if not enrichment["full_name"]:
                        enrichment["full_name"] = name_part

            # GitHub
            elif "github.com/" in url and not enrichment["github_url"]:
                enrichment["github_url"] = result.url

            # Twitter/X
            elif ("twitter.com/" in url or "x.com/" in url) and not enrichment["twitter_url"]:
                enrichment["twitter_url"] = result.url

            # Other URLs (personal sites, etc)
            else:
                if result.url not in enrichment["other_urls"]:
                    enrichment["other_urls"].append(result.url)

        # Convert other_urls to JSON for storage
        enrichment["other_urls"] = json.dumps(enrichment["other_urls"])

        return enrichment

    except Exception as e:
        print(f"  Exa error for {user['username']}: {e}")
        return None


def save_enrichment(enrichment):
    """Save enrichment data to database."""
    with get_cursor() as cur:
        cur.execute("""
            INSERT INTO enrichment (username, full_name, linkedin_url, github_url,
                                   twitter_url, company, title, location, bio,
                                   other_urls, raw_response, enriched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
                full_name = excluded.full_name,
                linkedin_url = excluded.linkedin_url,
                github_url = excluded.github_url,
                twitter_url = excluded.twitter_url,
                company = excluded.company,
                title = excluded.title,
                location = excluded.location,
                bio = excluded.bio,
                other_urls = excluded.other_urls,
                raw_response = excluded.raw_response,
                enriched_at = excluded.enriched_at
        """, (
            enrichment["username"],
            enrichment["full_name"],
            enrichment["linkedin_url"],
            enrichment["github_url"],
            enrichment["twitter_url"],
            enrichment["company"],
            enrichment["title"],
            enrichment["location"],
            enrichment["bio"],
            enrichment["other_urls"],
            enrichment["raw_response"],
            enrichment["enriched_at"],
        ))


def main(max_users=None, dry_run=False):
    """
    Main enrichment loop.

    Args:
        max_users: Maximum number of users to enrich (for budget control)
        dry_run: If True, just print what would be searched without calling Exa
    """
    init_db()

    # Check for API key
    api_key = os.environ.get("EXA_API_KEY")
    if not api_key and not dry_run:
        print("Error: EXA_API_KEY environment variable not set")
        print("Get your API key from https://exa.ai")
        return

    # Get users eligible for enrichment
    users = get_users_for_enrichment()
    print(f"Found {len(users)} users eligible for enrichment")

    if max_users:
        users = users[:max_users]
        print(f"Limited to {max_users} users")

    if dry_run:
        print("\n=== DRY RUN - Not calling Exa API ===\n")
        for user in users:
            query = build_search_query(dict(user))
            if query:
                print(f"{user['username']}: {query[:80]}...")
        return

    # Initialize Exa client
    exa = Exa(api_key=api_key)

    enriched_count = 0
    skipped_count = 0

    for i, user in enumerate(users):
        print(f"[{i+1}/{len(users)}] Enriching {user['username']}...")

        enrichment = enrich_user(exa, dict(user))

        if enrichment:
            save_enrichment(enrichment)
            enriched_count += 1
            print(f"  -> Found: {enrichment.get('full_name') or 'no name'}, "
                  f"LinkedIn: {'yes' if enrichment.get('linkedin_url') else 'no'}")
        else:
            skipped_count += 1
            print(f"  -> No results")

        time.sleep(REQUEST_DELAY)

    print(f"\nDone! Enriched {enriched_count}, skipped {skipped_count}")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Enrich lobsters users with Exa")
    parser.add_argument("--max", type=int, help="Maximum users to enrich")
    parser.add_argument("--dry-run", action="store_true", help="Show queries without calling API")
    args = parser.parse_args()

    main(max_users=args.max, dry_run=args.dry_run)
