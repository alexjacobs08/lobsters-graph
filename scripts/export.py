"""Export SQLite data to JSON for the static site."""

import json
import sys
from pathlib import Path

# Add scraper to path for db module
sys.path.insert(0, str(Path(__file__).parent.parent / "scraper"))

from db import get_all_users, get_invitation_tree, get_connection

OUTPUT_DIR = Path(__file__).parent.parent / "site" / "data"


def export_graph_json():
    """
    Export graph data in a format suitable for Sigma.js/Graphology.

    Format:
    {
        "nodes": [
            {"key": "username", "attributes": {...}},
            ...
        ],
        "edges": [
            {"source": "inviter", "target": "invitee"},
            ...
        ],
        "stats": {...}
    }
    """
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Get all users
    users = get_all_users()
    print(f"Exporting {len(users)} users...")

    # Build nodes
    nodes = []
    for user in users:
        node = {
            "key": user["username"],
            "attributes": {
                "label": user["username"],
                "karma": user["karma"] or 0,
                "created_at": user["created_at"],
                "about": user["about"] or "",
                "github": user["github_username"],
                "twitter": user["twitter_username"],
                "website": user["website"],
                "invited_by": user["invited_by_username"],
            }
        }
        # Node size based on karma (log scale)
        karma = user["karma"] or 1
        node["attributes"]["size"] = max(3, min(30, 3 + (karma ** 0.3)))
        nodes.append(node)

    # Build edges from invitation tree
    edges = get_invitation_tree()
    edge_list = []
    for edge in edges:
        edge_list.append({
            "source": edge["inviter"],
            "target": edge["invitee"],
        })

    print(f"Exporting {len(edge_list)} invitation edges...")

    # Calculate some stats
    conn = get_connection()
    conn.row_factory = None
    cur = conn.cursor()

    cur.execute("SELECT COUNT(*) FROM users")
    total_users = cur.fetchone()[0]

    cur.execute("SELECT MAX(karma) FROM users")
    max_karma = cur.fetchone()[0] or 0

    cur.execute("SELECT AVG(karma) FROM users")
    avg_karma = cur.fetchone()[0] or 0

    cur.execute("""
        SELECT invited_by_username, COUNT(*) as invite_count
        FROM users
        WHERE invited_by_username IS NOT NULL
        GROUP BY invited_by_username
        ORDER BY invite_count DESC
        LIMIT 20
    """)
    top_inviters = [{"username": row[0], "count": row[1]} for row in cur.fetchall()]

    conn.close()

    # Combine into output
    output = {
        "nodes": nodes,
        "edges": edge_list,
        "stats": {
            "total_users": total_users,
            "total_edges": len(edge_list),
            "max_karma": max_karma,
            "avg_karma": round(avg_karma, 1),
            "top_inviters": top_inviters,
        }
    }

    # Write to file
    output_path = OUTPUT_DIR / "graph.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)

    print(f"Exported to {output_path}")
    print(f"Stats: {total_users} users, {len(edge_list)} edges, max karma: {max_karma}")

    return output


def export_enriched_json():
    """Export enrichment data separately for lazy loading."""
    conn = get_connection()
    conn.row_factory = None
    cur = conn.cursor()

    cur.execute("""
        SELECT username, full_name, linkedin_url, github_url, twitter_url,
               company, title, location, bio, other_urls
        FROM enrichment
    """)

    enriched = {}
    for row in cur.fetchall():
        username = row[0]
        enriched[username] = {
            "full_name": row[1],
            "linkedin": row[2],
            "github": row[3],
            "twitter": row[4],
            "company": row[5],
            "title": row[6],
            "location": row[7],
            "bio": row[8],
            "other_urls": json.loads(row[9]) if row[9] else [],
        }

    conn.close()

    output_path = OUTPUT_DIR / "enriched.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(enriched, f, indent=2)

    print(f"Exported {len(enriched)} enriched profiles to {output_path}")


if __name__ == "__main__":
    export_graph_json()
    export_enriched_json()
