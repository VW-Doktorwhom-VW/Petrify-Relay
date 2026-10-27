# Petrify plugin settings

The Jellyfin dashboard page configures the bundled relay; all changes take effect
only after restarting Jellyfin. Plugin version 1.2.1.0 preserves the original
`ServerPort` setting and defaults new fields for existing installations.

| Setting | Relay environment | Default | Validation |
| --- | --- | --- | --- |
| Relay TCP port | `PETRIFY_PORT` | 8787 | Integer 1–65535 |
| Discovery UDP port | `PETRIFY_DISCOVERY_PORT` | 8788 | Integer 1–65535 |
| Local Jellyfin base URLs | `PETRIFY_LOCAL_JELLYFIN` | `http://127.0.0.1:8096,http://localhost:8096` | Comma-separated HTTP(S) URLs, no credentials/query/fragment |
| Party command lead | `PETRIFY_PARTY_LEAD_MS` | 1000 ms | Integer 300–30000 |
| Party track-change lead | `PETRIFY_PARTY_TRACK_LEAD_MS` | 2200 ms | Integer 800–30000 |

Validation runs in the dashboard and before saving or starting the relay.
The timing ceiling is a plugin guardrail against accidental excessive delays.
TCP and UDP port numbers may match because they use different protocols.
Local URLs are candidate routes, not an allowlist: the relay compares public
Jellyfin server IDs and may also try Jellyfin's advertised local address.

The dashboard makes no automatic health requests. **Check relay now** explicitly
requests only `<entered relay base URL>/v1/health` from the administrator's browser
without browser credentials or referrer, with redirects rejected and a five-second
timeout. It displays only reported relay version, connection protocol, device count
and party on/off state; it never renders raw payloads or credentials. This is not a
test of UDP discovery, authentication, synchronization, media access or library health.
HTTPS, reverse proxies, private-network restrictions and firewalls can prevent a
browser check even when the relay is running.

The relay handles client playback state, media requests that can carry Jellyfin
tokens, and party/guest data. Keep it on a trusted network or protect it using your
network/reverse proxy. These settings do not add authentication, TLS, firewall
rules or Jellyfin user permissions. No new administrative endpoints are introduced.
