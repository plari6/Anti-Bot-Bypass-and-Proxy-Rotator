# Use the gateway from any Python scraper (antibot serve running on port 8787).
import requests

r = requests.post(
    "http://127.0.0.1:8787/v1/fetch",
    headers={"x-api-key": "change-me"},
    json={"url": "https://example.com/", "fields": ["title=h1"], "mustContain": "Example", "noBody": True},
    timeout=120,
)
data = r.json()
print(data["ok"], data.get("step"), data.get("fields"), data.get("costUsd"))
