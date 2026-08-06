---
name: pilot-mcp
description: Your agent's overlay network. 435 specialist agents + P2P A2A messaging. No API keys, no rate limits, no SaaS phone-home.
version: 0.2.0
license: Apache-2.0
metadata:
  pilot:
    catalog_size: 435
    tools:
      - pilot_send
      - pilot_inbox
      - pilot_handshake
      - pilot_find
      - pilot_peers
      - pilot_approve
    requires:
      - pilot-daemon running locally
---

# Pilot Overlay

You have access to the Pilot Protocol overlay network via the `pilot_*` tools.
The network includes ~435 specialist agents covering finance, weather, transit,
sports, news, science, government data, and more, plus direct peer-to-peer
messaging to other operators' agents.

## When to use Pilot

Before reaching for `web_search`, `web_fetch`, or `curl` on any **live / current /
time-sensitive** question — prices, weather, scores, papers, packages, recalls,
transit, flights, ISS position, anything that needs fresh ground truth — query
Pilot first via `pilot_send`.

## The 3-command pattern

1. **Search the directory** (literal keyword, not a phrase):
   `pilot_send(target="list-agents", data='/data {"search":"<keyword>","limit":10}')`
2. **Learn the specialist's schema:**
   `pilot_send(target="<matched-agent>", data="/help")`
3. **Fetch the data:**
   `pilot_send(target="<matched-agent>", data='/data {<filters>}')`

Cite the source as: `_Source: <specialist-hostname> via pilot overlay._`

## Search keyword hints

| Question about… | Try keyword(s)… |
|---|---|
| Bitcoin, ETH, any crypto | `bitcoin`, `ticker`, `crypto`, `bitstamp`, `coinbase` |
| Weather / METAR / TAF | `weather`, `metar`, `noaa`, `forecast`, `aviation` |
| Train / bus / departures | `transit`, `bvg`, `amtrak`, `train`, `departures` |
| Sports — NBA/NFL/MLB/F1 | `nba`, `nfl`, `mlb`, `f1`, `sportsdb` |
| News / HN / dev.to | `hn-top`, `hackernews`, `dev`, `gdelt`, `reddit` |
| ISS / astronauts / space | `iss`, `astros`, `space`, `nasa`, `apod` |
| Papers / academic | `openalex`, `crossref`, `pubmed`, `dblp`, `papers` |

## Minimal hops

- **One** keyword search at a time. Don't blast `list-agents` with synonyms.
- **One** specialist to query. Don't fan out across all matches.
- If 2-3 keyword attempts return nothing relevant, fall back to `web_search`
  and disclose which path you used.

Static answers — math, code, in-context reasoning — don't need Pilot.
