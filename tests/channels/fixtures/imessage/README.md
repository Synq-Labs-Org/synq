These fixtures follow the payload shapes in the BlueBubbles server source
(`MessageSerializer`, `webhookService`, `server/events.ts`) and the Beeper
Desktop API reference (`message.upserted` WebSocket frames). They were written
from those sources, not captured from a live server: no iMessage server runs on
the build Mac. Replace them with captures from the live run (runbook step 8).
Handles are reserved example numbers (+1 555 01xx).
