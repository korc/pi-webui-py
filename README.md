# pi web ui

A web UI for [pi](https://pi.dev), the minimal coding agent harness.

The UI is a small Python (stdlib-only) HTTP server that spawns a long-lived
`pi --mode rpc` subprocess and bridges it to a browser over HTTP + Server-Sent
Events (SSE).

## Run it

```bash
python3 server.py
```

Then open <http://localhost:8787> in your browser.

Configuration via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PI_WEB_HOST` | `0.0.0.0` | Bind address |
| `PI_WEB_PORT` | `8787` | HTTP port |
| `PI_WEB_CWD` | `/home/user/aaaa` | Working directory of the pi agent |

## Architecture

```
Browser (web/)  --HTTP POST /api/command-->  Python server (server.py)  --JSONL stdin-->  pi --mode rpc
                      --GET  /api/events (SSE)-->  Python server  --stdout-->  pi --mode rpc
```

- The browser talks only to the Python server. The pi subprocess is never
  exposed directly.
- Commands (`prompt`, `abort`, `get_state`, `get_available_models`, ...) are
  sent to `pi` over stdin and the matching `response` record is returned via the
  command endpoint. Streaming session events (`agent_start`, `message_update`,
  `tool_execution_*`, ...) flow to the browser over SSE.
- Extension UI dialogs (`select`, `confirm`, `input`, `editor`) requested by pi
  extensions are surfaced in the browser and answered back over
  `/api/ui-response`.

## Frontend features

- Streaming chat with markdown rendering (code fences, lists, quotes, inline
  code / bold / italic / links).
- Thinking blocks (collapsible).
- Tool call cards with arguments and results (bash commands with output,
  errors, durations).
- Steering / follow-up queue display (`queue_update`).
- Status pill (idle / streaming / error), retry indicator.
- Token / cost / context usage stats.
- Model picker and thinking-level picker backed by pi's RPC commands.
- Compact context, abort, and extension UI dialogs.

## Protocol notes

See the pi documentation:

- `pi --mode rpc` protocol: <https://github.com/earendil-works/pi/blob/main/docs/rpc.md>
- JSON event stream: <https://github.com/earendil-works/pi/blob/main/docs/json.md>
- RPC extension UI: <https://github.com/earendil-works/pi/blob/main/docs/rpc-extension-ui.md>
- Message types: <https://github.com/earendil-works/pi/blob/main/docs/message-types.md>

The implementation follows the strict JSONL framing rules: records are one JSON
object per LF-terminated line, split only on `\n`, with optional trailing `\r`.
