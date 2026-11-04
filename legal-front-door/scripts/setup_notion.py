"""Create the 'Corporate requests' database in Notion with every property the workflow writes.

1. Create an internal integration at https://www.notion.so/profile/integrations and copy its secret.
2. Create an empty Notion page, open its "..." menu > Connections, and add your integration.
3. Run:
       NOTION_TOKEN=ntn_xxx python3 scripts/setup_notion.py "<link or id of that page>"
4. Paste the printed database ID into the "Config" node in n8n.

No dependencies beyond the Python standard library.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEAMS = ["Sales", "Care", "Product", "Marketing", "Partnerships", "People", "Operations", "Finance", "Other"]


def select(names, colors=None):
    return {"select": {"options": [
        {"name": n, **({"color": colors[i]} if colors else {})} for i, n in enumerate(names)
    ]}}


def main():
    token = os.environ.get("NOTION_TOKEN")
    if not token or len(sys.argv) != 2:
        sys.exit(__doc__)
    match = re.search(r"([0-9a-f]{32})", sys.argv[1].replace("-", ""))
    if not match:
        sys.exit("Couldn't find a page id (32 hex characters) in: " + sys.argv[1])
    parent_id = match.group(1)

    playbook = json.loads((ROOT / "playbook.json").read_text(encoding="utf-8"))
    owners = sorted({c["owner"] for c in playbook["categories"]} | {playbook["settings"]["triage_owner"]})
    text = {"rich_text": {}}
    body = {
        "parent": {"type": "page_id", "page_id": parent_id},
        "title": [{"type": "text", "text": {"content": "Corporate requests"}}],
        "properties": {
            "Request": {"title": {}},
            "Reference": text,
            "Requester": {"email": {}},
            "Team": select(TEAMS),
            "Category": select([c["label"] for c in playbook["categories"]]),
            "Risk": select(["low", "medium", "high"], ["green", "yellow", "red"]),
            "Route": select(["Auto-answered", "Owner queue", "Urgent escalation", "Human triage"],
                            ["green", "blue", "red", "orange"]),
            "Owner": select(owners),
            "Status": select(["New", "In progress", "Answered", "Done"], ["gray", "blue", "green", "green"]),
            "Route check": select(["Not reviewed", "Correct", "Wrong route"], ["gray", "green", "red"]),
            "Confidence": {"number": {"format": "percent"}},
            "Red flags": text,
            "Reasons": text,
            "AI summary": text,
            "Full request": text,
            "Received": {"date": {}},
            "SLA due": {"date": {}},
            "First response": {"date": {}},
            "Model ms": {"number": {"format": "number"}},
            "Model": text,
        },
    }
    req = urllib.request.Request(
        "https://api.notion.com/v1/databases",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Notion-Version": "2022-06-28",
                 "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as r:
            db = json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"Notion API error {e.code}: {e.read().decode()}\n"
                 "Check the token, and that the page is shared with your integration (... > Connections).")
    print("Created database:", db.get("url"))
    print("Database ID for the n8n Config node:", db["id"])


if __name__ == "__main__":
    main()
