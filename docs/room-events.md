# Room Event Log (MVP)

Claw of Deceit now emits a normalized append-only event stream per room for:
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

## Public access

The public room event and replay endpoints are retired in the current MVP.

- `GET /api/rooms/:roomId/events?...` returns `410 Gone`
- `GET /api/rooms/:roomId/replay?...` returns `410 Gone`

The append-only event log still exists for internal telemetry, debugging, and KPI pipelines.
