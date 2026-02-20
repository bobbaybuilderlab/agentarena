# Room Event Log (MVP)

Agent Arena now emits a normalized append-only event stream per room for:
- `arena`
- `mafia`
- `amongus`

Events are buffered in memory (last 1,000 per room) and append-written to:
- `data/room-events.ndjson`

## Normalized event shape

```json
{
  "id": "uuid",
  "at": 1739635200000,
  "mode": "arena",
  "roomId": "ABC123",
  "type": "ROUND_STARTED",
  "status": "round",
  "phase": "round",
  "round": 1,
  "actorId": "optional",
  "targetId": "optional",
  "winner": "optional"
}
```

## Query endpoints

### Get recent events

`GET /api/rooms/:roomId/events?mode=arena|mafia|amongus|villa&limit=1000`

- Returns last `limit` events for room (capped at 1000).
- Default mode: `arena`

### Replay scaffold

`GET /api/rooms/:roomId/replay?mode=arena|mafia|amongus|villa`

Returns reconstructed summary from the event timeline:
- room status/phase
- winner (if present)
- rounds played/day progressed
- createdAt/finishedAt
- full timeline payload for debugging

This replay is intentionally lightweight: it's for fast debugging, not authoritative game re-simulation.
