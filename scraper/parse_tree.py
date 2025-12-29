"""
Parse the lobste.rs users.html tree structure.

The HTML has nested <ul class="user_tree"> elements where nesting represents
the invitation hierarchy. Each user is in an <li> with:
  <a name="username" href="/~username">username</a> (karma)
"""

import re
from pathlib import Path
from bs4 import BeautifulSoup

from db import init_db, upsert_user


def parse_users_tree(html):
    """
    Parse the nested user tree from lobste.rs/users HTML.
    Returns list of dicts with username, karma, invited_by_username.
    """
    soup = BeautifulSoup(html, "html.parser")
    users = []

    def parse_li(li_element, parent_username=None):
        """Recursively parse an <li> element and its children."""
        # Find the user link in this <li>
        link = li_element.find("a", href=re.compile(r"^/~"), recursive=False)
        if not link:
            # Try finding it as first <a> child
            link = li_element.find("a", href=re.compile(r"^/~"))

        if not link:
            return

        username = link.get("name") or link["href"].replace("/~", "")

        # Extract karma from the text after the link
        # The format is: <a>username</a> (karma)
        li_text = li_element.get_text()
        karma_match = re.search(rf"{re.escape(username)}\s*\((\d+)\)", li_text)
        karma = int(karma_match.group(1)) if karma_match else 0

        # Check if user is inactive (has class="inactive_user")
        is_inactive = "inactive_user" in link.get("class", [])

        users.append({
            "username": username,
            "karma": karma,
            "invited_by_username": parent_username,
            "is_inactive": is_inactive,
        })

        # Find nested user_tree ul for users invited by this user
        nested_ul = li_element.find("ul", class_="user_tree", recursive=False)
        if nested_ul:
            for child_li in nested_ul.find_all("li", recursive=False):
                parse_li(child_li, parent_username=username)

    # Find the main user tree
    main_tree = soup.find("ul", class_="user_tree")
    if not main_tree:
        print("Could not find user_tree element")
        return []

    # Parse all top-level <li> elements (roots of the tree)
    for li in main_tree.find_all("li", recursive=False):
        parse_li(li, parent_username=None)

    return users


def main():
    """Parse users.html and populate the database."""
    init_db()

    html_path = Path(__file__).parent.parent / "data" / "users.html"

    if not html_path.exists():
        print(f"Error: {html_path} not found")
        return

    print(f"Reading {html_path}...")
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()

    print("Parsing user tree...")
    users = parse_users_tree(html)

    print(f"Found {len(users)} users")

    # Insert into database
    for i, user in enumerate(users):
        upsert_user(
            username=user["username"],
            karma=user["karma"],
            invited_by_username=user["invited_by_username"],
        )
        if (i + 1) % 1000 == 0:
            print(f"  Inserted {i + 1} users...")

    print(f"Done! Inserted {len(users)} users into database")

    # Print some stats
    roots = [u for u in users if u["invited_by_username"] is None]
    print(f"\nStats:")
    print(f"  Root users (no inviter): {len(roots)}")
    print(f"  Total users: {len(users)}")

    # Top karma users
    top_karma = sorted(users, key=lambda u: u["karma"], reverse=True)[:10]
    print(f"\nTop 10 by karma:")
    for u in top_karma:
        print(f"  {u['username']}: {u['karma']}")

    # Top inviters (count invitees)
    invite_counts = {}
    for u in users:
        inviter = u["invited_by_username"]
        if inviter:
            invite_counts[inviter] = invite_counts.get(inviter, 0) + 1

    top_inviters = sorted(invite_counts.items(), key=lambda x: x[1], reverse=True)[:10]
    print(f"\nTop 10 inviters:")
    for username, count in top_inviters:
        print(f"  {username}: {count} invites")


if __name__ == "__main__":
    main()
