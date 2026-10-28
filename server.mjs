/**
 * Petrify service. Run this on the machine that stays on.
 * Clients (Windows app, Android app, browser) connect to it.
 * They do not connect to each other.
 *
 *   node service/server.mjs
 *
 * Default address: http://0.0.0.0:8787
 */
import { createServer } from "node:http";
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";

const PORT = Number(process.env.PETRIFY_PORT || 8787);
const DISCOVERY_PORT = Number(process.env.PETRIFY_DISCOVERY_PORT || 8788);
const PLAYER_PORT = Number(process.env.PETRIFY_PLAYER_PORT || 8090);
const ALLOWED = ["/Items/", "/Audio/", "/Images/", "/Playlists/", "/System/", "/Users/", "/Sessions/"];
const devices = new Map();
const playbackState = new Map();
const playbackSnapshots = new Map();
const diagnosticEvents = [];
const transferStates = new Map();
const pendingTransfers = new Map();
const userByToken = new Map();
const partyInvites = new Map();
let seq = 1;
let activeId = "";
let activeTrackId = "";
// Sub-millisecond wall clock shared by party timing and /v1/time.
const hrNow = () => performance.timeOrigin + performance.now();

function savePlaybackState(deviceId, state) {
  playbackState.set(deviceId, { ...state, updatedAt: Date.now() });
}

const PARTY_TIMELINE_FIELDS = ["index", "trackId", "anchorPos", "anchorAt", "playing", "repeat"];

function partyTimelineSnapshot() {
  return Object.fromEntries(PARTY_TIMELINE_FIELDS.map((key) => [key, party[key]]));
}

function restorePartyTimeline(snapshot) {
  for (const key of PARTY_TIMELINE_FIELDS) party[key] = snapshot[key];
}

const freshWaiters = new Map();

// Asks the playing device for its exact position, only when a transfer is requested.
function requestFreshState(deviceId, ms = 1200) {
  const device = devices.get(deviceId);
  if (!device || !device.res.size) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      freshWaiters.delete(deviceId);
      resolve(false);
    }, ms);
    freshWaiters.set(deviceId, () => {
      clearTimeout(timer);
      freshWaiters.delete(deviceId);
      resolve(true);
    });
    const command = { type: "REPORT", id: seq++, to: deviceId };
    for (const sock of device.res) writeSse(sock, room(command));
  });
}

function currentPlaybackState(deviceId) {
  const state = playbackState.get(deviceId);
  if (!state) return null;
  const elapsed = state.playing ? Math.max(0, (Date.now() - (state.updatedAt || Date.now())) / 1000) : 0;
  const position = state.position + elapsed;
  return {
    ...state,
    position: state.duration > 0 ? Math.min(state.duration, position) : position,
  };
}

function targetMediaUrl(raw, target) {
  if (!raw || !target?.origin) return raw;
  try {
    const url = new URL(raw, target.origin);
    if (url.pathname !== "/api/jf") return raw;
    return `${target.origin}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return raw;
  }
}

function playbackSnapshot(body, fallbackTrackId = "") {
  const trackId = String(body.trackId || fallbackTrackId || "");
  const mediaUrl = String(body.mediaUrl || "");
  const mediaQueue = Array.isArray(body.mediaQueue)
    ? body.mediaQueue.slice(0, 200)
      .filter((item) => item && typeof item.id === "string" && typeof item.url === "string")
      .map((item) => ({
        id: item.id,
        title: String(item.title || ""),
        artist: String(item.artist || ""),
        album: String(item.album || ""),
        url: item.url,
        cover: String(item.cover || ""),
      }))
    : [];
  if (!mediaQueue.length && trackId && mediaUrl) {
    mediaQueue.push({
      id: trackId,
      title: String(body.title || ""),
      artist: String(body.artist || ""),
      album: String(body.album || ""),
      url: mediaUrl,
      cover: String(body.cover || ""),
    });
  }
  return {
    trackId,
    mediaUrl,
    title: String(body.title || ""),
    artist: String(body.artist || ""),
    album: String(body.album || ""),
    cover: String(body.cover || ""),
    position: Math.max(0, Number(body.position) || 0),
    duration: Math.max(0, Number(body.duration) || 0),
    volume: typeof body.volume === "number" && Number.isFinite(body.volume)
      ? Math.max(0, Math.min(1, body.volume))
      : undefined,
    queue: Array.isArray(body.queue) ? body.queue.slice(0, 200).map(String) : [trackId],
    mediaQueue,
  };
}

function recordDiagnostic(event, details = {}) {
  const safeDetails = { ...details };
  if (typeof safeDetails.error === "string") {
    safeDetails.error = safeDetails.error
      .replace(/https?:\/\/\S+/gi, "[url]")
      .replace(/([?&](?:token|api_key|apikey|password)=)[^&\s]*/gi, "$1[redacted]");
  }
  const entry = {
    time: new Date().toISOString(),
    event: String(event).slice(0, 80),
    ...safeDetails,
  };
  diagnosticEvents.push(entry);
  if (diagnosticEvents.length > 500) diagnosticEvents.shift();
  console.log(`[${entry.time}] ${entry.event} ${JSON.stringify(safeDetails)}`);
  return entry;
}

function setTransferState(transferId, status, details = {}) {
  if (!transferId) return;
  const entry = { transferId, status, updatedAt: new Date().toISOString(), ...details };
  transferStates.set(transferId, entry);
  recordDiagnostic(`transfer-${status}`, { transferId, ...details });
  while (transferStates.size > 100) transferStates.delete(transferStates.keys().next().value);
  broadcast(room({ type: "TRANSFER_STATUS", id: seq++, transfer: entry }));
}

function stopDevice(deviceId, transferId = "") {
  const device = devices.get(deviceId);
  if (!device || (party.on && !transferId)) return;
  const stop = { type: "STOP", id: seq++, to: deviceId, transferId };
  for (const sock of device.res) writeSse(sock, room(stop));
  const state = playbackState.get(deviceId);
  if (state) savePlaybackState(deviceId, { ...currentPlaybackState(deviceId), playing: false });
}

function restoreTransferSource(transferId, reason) {
  const pending = pendingTransfers.get(transferId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingTransfers.delete(transferId);
  stopDevice(pending.targetId, transferId);
  savePlaybackState(pending.targetId, {
    ...(currentPlaybackState(pending.targetId) || { position: 0, duration: 0 }),
    playing: false,
  });
  if (pending.sourceId && devices.has(pending.sourceId)) {
    activeId = pending.sourceId;
    activeTrackId = pending.sourceTrackId;
    savePlaybackState(pending.sourceId, pending.sourceState);
  } else {
    activeId = "";
    activeTrackId = "";
  }
  broadcast(room(null));
  setTransferState(transferId, "failed", {
    sourceId: pending.sourceId,
    targetId: pending.targetId,
    trackId: pending.sourceTrackId,
    error: reason,
  });
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendJson(res, code, body) {
  cors(res);
  const data = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function authHeaders(token, deviceId) {
  const tokenPart = token ? `, Token="${token}"` : "";
  const scheme = `MediaBrowser Client="Petrify", Device="Petrify", DeviceId="${deviceId}", Version="1.0.0"${tokenPart}`;
  const headers = {
    Authorization: scheme,
    "X-Emby-Authorization": scheme,
  };
  if (token) headers["X-Emby-Token"] = token;
  return headers;
}

async function jf(base, path, token, deviceId, init = {}) {
  const headers = { ...authHeaders(token, deviceId), ...(init.headers || {}) };
  const res = await fetch(`${base}${path}`, { ...init, headers });
  return res;
}

function cleanBase(raw) {
  const url = new URL(String(raw || "").trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Use an http or https address.");
  return url.toString().replace(/\/$/, "");
}

function absolute(req, pathAndQuery) {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto === "https" || req.socket.encrypted ? "https" : "http";
  return `${protocol}://${host}${pathAndQuery}`;
}

function mediaUrl(req, base, token, deviceId, path) {
  return absolute(
    req,
    `/api/jf?base=${encodeURIComponent(base)}&token=${encodeURIComponent(token)}&device=${encodeURIComponent(deviceId)}&path=${encodeURIComponent(path)}`,
  );
}

async function login(body, req) {
  const base = cleanBase(body.url);
  const deviceId = String(body.deviceId || "petrify").replace(/[^\w.-]/g, "").slice(0, 64) || "petrify";
  const infoRes = await jf(base, "/System/Info/Public", body.apiKey || "", deviceId, {
    signal: AbortSignal.timeout(12_000),
  });
  if (!infoRes.ok) return { ok: false, error: `Jellyfin answered ${infoRes.status}.` };
  const info = await infoRes.json();
  let token = String(body.apiKey || "").trim();
  let userId = "";
  if (!token) {
    if (!body.username || !body.password) return { ok: false, error: "Enter a username and password, or an API key." };
    const authRes = await jf(base, "/Users/AuthenticateByName", "", deviceId, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Username: body.username, Pw: body.password }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!authRes.ok) {
      const detail = (await authRes.text()).slice(0, 180);
      return { ok: false, error: `Sign-in was refused (${authRes.status})${detail ? `: ${detail}` : "."}` };
    }
    const auth = await authRes.json();
    token = auth.AccessToken || "";
    userId = auth.User?.Id || "";
    if (!token) return { ok: false, error: "Jellyfin did not return a token." };
  } else {
    const me = await jf(base, "/Users/Me", token, deviceId, { signal: AbortSignal.timeout(12_000) });
    if (me.ok) userId = (await me.json()).Id || "";
  }
  if (body.fast === true) {
    return {
      ok: true,
      serverName: info.ServerName || "Jellyfin",
      token,
      userId,
      tracks: [],
      albums: [],
      playlists: [],
      suggestions: [],
      albumArtists: [],
      artists: [],
      genres: [],
      collections: [],
    };
  }
  const q = userId ? `/Users/${userId}/Items` : "/Items";
  const pages = async (path, max = 100000) => {
    const items = [];
    for (let start = 0; start < max; start += 500) {
      const res = await jf(base, `${path}&StartIndex=${start}&Limit=${Math.min(500, max - start)}`, token, deviceId);
      if (!res.ok) {
        if (!start) return null;
        break;
      }
      const body = await res.json();
      const got = body.Items || [];
      items.push(...got);
      if (!got.length || items.length >= Number(body.TotalRecordCount ?? 0)) break;
    }
    return items;
  };
  const trackItems = await pages(
    `${q}?IncludeItemTypes=Audio&Recursive=true&SortBy=DateCreated&SortOrder=Descending&Fields=Album,AlbumArtists,Artists,Genres,RunTimeTicks,MediaSources,ProductionYear,ReplayGainTrackGain,ReplayGainTrackPeak`,
    2000,
  );
  if (!trackItems) return { ok: false, error: "Library request failed." };
  const albumItems =
    (await pages(`${q}?IncludeItemTypes=MusicAlbum&Recursive=true&SortBy=SortName&SortOrder=Ascending&Fields=AlbumArtists,ProductionYear,DateCreated`)) || [];
  const toTrack = (item) => {
    const id = String(item.Id || "");
    const albumId = String(item.AlbumId || "");
    const artists = Array.isArray(item.Artists) ? item.Artists.map(String) : [];
    return {
      id,
      title: String(item.Name || "Untitled"),
      artist: artists[0] || String(item.AlbumArtist || "Unknown"),
      albumId,
      album: String(item.Album || ""),
      cover: mediaUrl(req, base, token, deviceId, `/Items/${albumId || id}/Images/Primary?maxWidth=600&quality=80`),
      src: mediaUrl(
        req,
        base,
        token,
        deviceId,
        `/Audio/${id}/universal?Container=mp3&AudioCodec=mp3&TranscodingContainer=mp3&MaxStreamingBitrate=256000&TranscodingProtocol=http`,
      ),
      secs: Number(item.RunTimeTicks || 0) / 10_000_000 || 0,
      replayGainTrackGainDb: Number.parseFloat(String(item.ReplayGainTrackGain || "")) || 0,
      replayGainTrackPeak: Number(item.ReplayGainTrackPeak || 0) || undefined,
      size: Number(item.MediaSources?.[0]?.Size || 0),
      bitrate: Number(item.MediaSources?.[0]?.Bitrate || 0),
      container: String(item.MediaSources?.[0]?.Container || item.Container || ""),
      year: item.ProductionYear ? String(item.ProductionYear) : "",
      genres: Array.isArray(item.Genres) ? item.Genres.map(String) : [],
      artists,
      albumArtist: String(item.AlbumArtist || artists[0] || "Unknown"),
      kind: "music",
      lyrics: [],
    };
  };
  const tracks = trackItems.map(toTrack);
  const known = new Set(tracks.map((track) => track.id));
  const albums = albumItems.map((item) => {
    const id = String(item.Id || "");
    return {
      id,
      title: String(item.Name || "Untitled"),
      artist: String(item.AlbumArtist || "Unknown"),
      year: item.ProductionYear ? String(item.ProductionYear) : "",
      cover: mediaUrl(req, base, token, deviceId, `/Items/${id}/Images/Primary?maxWidth=600&quality=80`),
    };
  });
  const playlistItems = (await pages(`${q}?IncludeItemTypes=Playlist&Recursive=true&SortBy=SortName`, 200)) || [];
  const playlists = [];
  for (const playlist of playlistItems) {
    const id = String(playlist.Id || "");
    const children =
      (await pages(`/Playlists/${id}/Items?UserId=${userId}&Fields=Album,AlbumArtists,Artists,Genres,RunTimeTicks,MediaSources,ProductionYear,ReplayGainTrackGain,ReplayGainTrackPeak`, 3000)) || [];
    for (const item of children) {
      const track = toTrack(item);
      if (track.id && !known.has(track.id)) {
        known.add(track.id);
        tracks.push(track);
      }
    }
    playlists.push({
      id,
      title: String(playlist.Name || "Playlist"),
      sub: `${children.length} songs`,
      cover: mediaUrl(req, base, token, deviceId, `/Items/${id}/Images/Primary?maxWidth=400&quality=80`),
      trackIds: children.map((item) => String(item.Id || "")),
    });
  }
  const colRes = await jf(base, `${q}?IncludeItemTypes=BoxSet&Recursive=true&Limit=40`, token, deviceId);
  const colJson = colRes.ok ? await colRes.json() : { Items: [] };
  const shelf = (kind) => {
    const groups = new Map();
    for (const track of tracks) {
      const names = kind === "genre"
        ? track.genres
        : kind === "albumArtist"
          ? [track.albumArtist]
          : track.artists.length ? track.artists : [track.artist];
      for (const name of names) {
        if (!name) continue;
        const ids = groups.get(name) || [];
        ids.push(track.id);
        groups.set(name, ids);
      }
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([title, trackIds]) => ({
      id: title,
      title,
      sub: `${trackIds.length} songs`,
      cover: "",
      trackIds,
    }));
  };
  return {
    ok: true,
    serverName: info.ServerName || "Jellyfin",
    token,
    userId,
    tracks,
    albums,
    playlists,
    suggestions: albumItems
      .map((item, index) => [String(item.DateCreated || ""), albums[index]])
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 16)
      .map((pair) => pair[1]),
    albumArtists: shelf("albumArtist"),
    artists: shelf("artist"),
    genres: shelf("genre"),
    collections: (colJson.Items || []).map((item) => ({
      id: String(item.Id || ""),
      title: String(item.Name || "Collection"),
      sub: "Collection",
      cover: mediaUrl(req, base, token, deviceId, `/Items/${item.Id}/Images/Primary?maxWidth=400&quality=80`),
      trackIds: [],
    })),
  };
}

function listDevices() {
  return [...devices.values()].map((device) => ({
    id: device.id,
    name: device.name,
    kind: device.kind || "",
    playing: device.id === activeId && Boolean(currentPlaybackState(device.id)?.playing),
    trackId: device.id === activeId ? activeTrackId : "",
    position: device.id === activeId ? currentPlaybackState(device.id)?.position || 0 : 0,
    duration: device.id === activeId ? currentPlaybackState(device.id)?.duration || 0 : 0,
  }));
}

function room(command = null) {
  return { devices: listDevices(), activeId, command };
}

function writeSse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(data, only) {
  for (const [id, device] of devices) {
    if (only && (Array.isArray(only) ? !only.includes(id) : id !== only)) continue;
    for (const res of device.res) {
      try {
        writeSse(res, data);
      } catch {
        device.res.delete(res);
      }
    }
  }
}

// Party mode: the service owns one shared timeline and every member device follows it.
//
// Timeline model (all times are the service's wall clock in ms, see hrNow):
//   PTS: the media position `anchorPos` (seconds) is presented at server time `anchorAt`.
//   While playing, the frame due at server time T is  anchorPos + (T - anchorAt) / 1000.
// Every change (start, seek, play, next...) sets anchorAt a little in the future
// (PARTY_LEAD_MS) so all members can buffer, park on that exact frame, and start together.
// Clients map server time to their own clock with an NTP-style offset (GET /v1/time):
//   local play time = anchorAt - clockOffset,  where clockOffset = serverClock - localClock.
const RELAY_VERSION = "1.2.8";
const PARTY_LEAD_MS = Math.max(300, Number(process.env.PETRIFY_PARTY_LEAD_MS || 1000));
// A new track needs a fresh stream on every member, so track changes get a longer runway.
const PARTY_TRACK_LEAD_MS = Math.max(800, Number(process.env.PETRIFY_PARTY_TRACK_LEAD_MS || 2200));
const party = {
  on: false,
  mode: "sync",
  rev: 0,
  host: "",
  roles: {},
  // Participating device ids. Empty means every connected device follows the party.
  members: [],
  mediaQueue: [],
  queue: [],
  queueVotes: {},
  voterOptOut: [],
  zones: {},
  zoneStates: {},
  index: 0,
  trackId: "",
  anchorPos: 0,
  anchorAt: 0,
  playing: false,
  repeat: "off",
};
// Latest sync report per device: { drift, rtt, status, at } (ms). Not part of rev.
const partyStats = new Map();
const partyGuestStreams = new Set();
let partyTimer = null;
const partyZoneTimers = new Map();

function partyPosition(now = hrNow()) {
  if (!party.playing) return party.anchorPos;
  return Math.max(0, party.anchorPos + (now - party.anchorAt) / 1000);
}

function partyTimelinePosition(timeline, now = hrNow()) {
  if (!timeline.playing) return timeline.anchorPos;
  return Math.max(0, timeline.anchorPos + (now - timeline.anchorAt) / 1000);
}

function partyTrack(id = party.trackId) {
  return party.mediaQueue.find((item) => item.id === id) || null;
}

function partyVoteSummary(trackId) {
  const id = String(trackId || "");
  const vote = party.queueVotes[id] || { score: 0, up: 0, down: 0, submittedAt: 0, voters: {} };
  return {
    score: Number(vote.score || 0),
    up: Number(vote.up || 0),
    down: Number(vote.down || 0),
    submittedAt: Number(vote.submittedAt || 0),
    voters: vote.voters && typeof vote.voters === "object" ? vote.voters : {},
  };
}

function partyPublic(deviceId = "") {
  const serverNow = hrNow();
  const zone = deviceId ? party.zones[deviceId] || "Default" : "";
  const timeline = zone ? party.zoneStates[zone] || party : party;
  const stats = {};
  for (const [id, item] of partyStats) if (serverNow - item.at < 30000) stats[id] = item;
  const { zoneStates: _zoneStates, ...publicParty } = party;
  const { zoneStates: _ignoredZoneStates, ...publicTimeline } = timeline;
  return {
    ...publicParty,
    ...publicTimeline,
    zone,
    serverNow,
    leadMs: PARTY_LEAD_MS,
    trackLeadMs: PARTY_TRACK_LEAD_MS,
    roles: { ...(party.roles || {}) },
    queueVotes: Object.fromEntries(Object.keys(party.queueVotes || {}).map((id) => [id, partyVoteSummary(id)])),
    voterCount: partyVoterCount(),
    // Explicit presentation time stamp of the shared timeline (same data as anchorPos/anchorAt).
    pts: { trackId: timeline.trackId, position: timeline.anchorPos, at: timeline.anchorAt, playing: timeline.playing },
    stats,
  };
}

function partyMessage(type, payload = {}, only) {
  broadcast({ ...room({ type, ...payload }) }, only);
}

/**
 * Songs already played keep their place; only the current song is locked. Everything after it is
 * ordered by net score (up - down). Voted songs with the same score play in the order of their first
 * vote (FIFO), and songs nobody voted on keep the original queue order, so after the voted songs the
 * queue simply continues as before.
 */
function sortPartyQueue() {
  if (!party.queue.length) return;
  const currentIndex = party.queue.indexOf(party.trackId);
  const played = currentIndex >= 0 ? party.queue.slice(0, currentIndex) : [];
  const upcoming = (currentIndex >= 0 ? party.queue.slice(currentIndex + 1) : party.queue.slice())
    .map((id, order) => ({ id, order, vote: partyVoteSummary(id) }))
    .sort((a, b) => {
      if (b.vote.score !== a.vote.score) return b.vote.score - a.vote.score;
      const av = a.vote.up + a.vote.down > 0 ? a.vote.submittedAt : 0;
      const bv = b.vote.up + b.vote.down > 0 ? b.vote.submittedAt : 0;
      if (av && bv && av !== bv) return av - bv;
      if (av && !bv) return -1;
      if (bv && !av) return 1;
      return a.order - b.order;
    })
    .map((entry) => entry.id);
  const ordered = currentIndex >= 0 ? [...played, party.trackId, ...upcoming] : upcoming;
  party.queue = [...new Set(ordered.filter(Boolean))];
  party.index = Math.max(0, party.queue.indexOf(party.trackId));
}

/** Every device connected to this relay instance may vote, whether or not it follows playback. */
function partyVoterCount() {
  return [...devices.keys()].filter((id) => !party.voterOptOut.includes(id)).length;
}

function partyVoter(id) {
  return Boolean(id) && devices.has(id) && !party.voterOptOut.includes(id);
}

function partyMember(id) {
  return !party.members.length || party.members.includes(id);
}

function cleanMembers(raw, host) {
  if (!Array.isArray(raw)) return [];
  const ids = [...new Set(raw.map((id) => String(id || "").slice(0, 64)).filter(Boolean))].slice(0, 64);
  if (ids.length && host && !ids.includes(host)) ids.unshift(host);
  return ids;
}

function partyBroadcast() {
  party.rev += 1;
  schedulePartyAdvance();
  for (const [id, device] of devices) {
    const data = room({ type: "PARTY", party: partyPublic(id) });
    for (const res of device.res) {
      try {
        writeSse(res, data);
      } catch {
        device.res.delete(res);
      }
    }
  }
  for (const stream of partyGuestStreams) {
    try {
      writeSse(stream.res, guestState(stream.inviteId, stream.key));
      if (!party.on) {
        clearInterval(stream.keepalive);
        stream.res.end();
        partyGuestStreams.delete(stream);
      }
    } catch {
      clearInterval(stream.keepalive);
      partyGuestStreams.delete(stream);
      stream.res.destroy();
    }
  }
}

function partyGo(index, lead = PARTY_TRACK_LEAD_MS) {
  const ids = party.queue.length ? party.queue : party.mediaQueue.map((item) => item.id);
  if (!ids.length) return;
  if (index >= ids.length) {
    if (party.repeat === "all") index = 0;
    else {
      party.playing = false;
      party.anchorPos = 0;
      party.anchorAt = hrNow();
      return;
    }
  }
  party.index = Math.max(0, index);
  party.trackId = ids[party.index];
  // The voted song is playing now: its votes are used up and a new round starts for the rest.
  if (party.queueVotes) delete party.queueVotes[party.trackId];
  party.anchorPos = 0;
  party.anchorAt = hrNow() + lead;
  party.playing = true;
}

function schedulePartyAdvance() {
  clearTimeout(partyTimer);
  partyTimer = null;
  for (const timer of partyZoneTimers.values()) clearTimeout(timer);
  partyZoneTimers.clear();
  if (!party.on) return;
  const schedule = (zone, timeline) => {
    if (!timeline.playing) return;
    const secs = Number(partyTrack(timeline.trackId)?.secs || 0);
    if (!(secs > 1)) return;
    const position = partyTimelinePosition(timeline);
    const left = (secs - position) * 1000 + Math.max(0, timeline.anchorAt - hrNow());
    const timer = setTimeout(() => {
      if (!party.on) return;
      const globalTimeline = zone ? partyTimelineSnapshot() : null;
      if (zone) restorePartyTimeline(party.zoneStates[zone] || timeline);
      if (!party.playing) {
        if (globalTimeline) restorePartyTimeline(globalTimeline);
        return;
      }
      if (party.repeat === "one") {
        party.anchorPos = 0;
        party.anchorAt = hrNow() + PARTY_TRACK_LEAD_MS;
      } else partyGo(party.index + 1);
      if (zone) party.zoneStates[zone] = partyTimelineSnapshot();
      recordDiagnostic("party-advanced", { trackId: party.trackId, ...(zone ? { zone } : {}) });
      if (globalTimeline) restorePartyTimeline(globalTimeline);
      else {
        // A global transition is authoritative for every zone.
        for (const name of Object.keys(party.zoneStates)) party.zoneStates[name] = partyTimelineSnapshot();
      }
      partyBroadcast();
    }, Math.max(250, left + 150));
    if (zone) partyZoneTimers.set(zone, timer);
    else partyTimer = timer;
  };
  schedule("", party);
  for (const [zone, timeline] of Object.entries(party.zoneStates)) schedule(zone, timeline);
}

function cleanMediaQueue(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 400).map((item) => ({
    id: String(item?.id || "").slice(0, 80),
    title: String(item?.title || "").slice(0, 200),
    artist: String(item?.artist || "").slice(0, 200),
    album: String(item?.album || "").slice(0, 200),
    url: String(item?.url || "").slice(0, 2000),
    cover: String(item?.cover || "").slice(0, 2000),
    secs: Number(item?.secs || 0) || 0,
  })).filter((item) => {
    if (!item.id) return false;
    try {
      const url = new URL(item.url, "http://petrify.invalid");
      return url.pathname === "/api/jf" && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  });
}

function inviteFor(body) {
  const inviteId = String(body.inviteId || "").slice(0, 40);
  const key = String(body.key || "");
  const invite = partyInvites.get(inviteId);
  if (!invite || invite.expiresAt <= Date.now()) {
    partyInvites.delete(inviteId);
    return null;
  }
  const candidate = createHash("sha256").update(key).digest();
  return timingSafeEqual(candidate, invite.keyHash) ? invite : null;
}

function partyCredentials() {
  for (const item of party.mediaQueue) {
    try {
      const url = new URL(item.url);
      const base = cleanBase(url.searchParams.get("base"));
      const token = url.searchParams.get("token") || "";
      const deviceId = (url.searchParams.get("device") || "petrify").slice(0, 64);
      if (base && token) return { base, token, deviceId };
    } catch {
      continue;
    }
  }
  return null;
}

function guestState(inviteId, key) {
  const track = partyTrack();
  const duration = Number(track?.secs || 0);
  const current = party.queue.indexOf(party.trackId);
  const queue = party.queue.slice(current + 1).map((id) => {
    const item = party.mediaQueue.find((entry) => entry.id === id);
    const vote = partyVoteSummary(id);
    return item ? { id, title: item.title, artist: item.artist, score: vote.score, up: vote.up, down: vote.down } : null;
  }).filter(Boolean);
  return {
    ok: true,
    party: {
      on: party.on,
      track: track ? {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        cover: track.cover
          ? `/v1/party/guest-image?inviteId=${encodeURIComponent(inviteId)}&key=${encodeURIComponent(key)}&trackId=${encodeURIComponent(track.id)}`
          : "",
      } : null,
      position: duration > 0 ? Math.min(duration, partyPosition() + Math.max(0, party.anchorAt - hrNow()) / 1000) : partyPosition(),
      duration,
      playing: party.playing,
      queue,
    },
  };
}

function validGuestId(raw) {
  const id = String(raw || "");
  return /^[a-zA-Z0-9_-]{8,48}$/.test(id) ? id : "";
}

/** Upvote (1), downvote (-1) or take back (0) one voter's vote on an upcoming song. */
function castVote(trackId, voter, voteValue, now = hrNow()) {
  if (!trackId || !voter || !(voteValue === 1 || voteValue === -1 || voteValue === 0)) return false;
  const position = party.queue.indexOf(trackId);
  // Only upcoming songs can be voted on; the playing song and the ones before it are settled.
  if (position < 0 || trackId === party.trackId || position < party.queue.indexOf(party.trackId)) return false;
  const next = party.queueVotes[trackId] || { score: 0, up: 0, down: 0, submittedAt: 0, voters: {} };
  const prev = Number(next.voters?.[voter] || 0);
  if (prev === voteValue) return false;
  next.voters = { ...(next.voters || {}) };
  if (prev === 1) next.up = Math.max(0, Number(next.up || 0) - 1);
  if (prev === -1) next.down = Math.max(0, Number(next.down || 0) - 1);
  if (voteValue === 1) next.up = Number(next.up || 0) + 1;
  if (voteValue === -1) next.down = Number(next.down || 0) + 1;
  if (voteValue === 0) delete next.voters[voter];
  else next.voters[voter] = voteValue;
  next.score = Number(next.up || 0) - Number(next.down || 0);
  if (next.up + next.down === 0) next.submittedAt = 0;
  else if (!next.submittedAt) next.submittedAt = now;
  party.queueVotes[trackId] = next;
  sortPartyQueue();
  return true;
}

async function guestSearch(body) {
  const query = String(body.query || "").trim().slice(0, 100);
  if (query.length < 2) return { ok: true, results: [] };
  const credentials = partyCredentials();
  if (!credentials) return { ok: false, error: "The host has not shared a searchable library." };
  const search = new URLSearchParams({
    SearchTerm: query,
    IncludeItemTypes: "Audio",
    Recursive: "true",
    Limit: "25",
    Fields: "Album,Artists,RunTimeTicks",
  });
  const me = await jf(credentials.base, "/Users/Me", credentials.token, credentials.deviceId, {
    signal: AbortSignal.timeout(8000),
  });
  const user = me.ok ? await me.json() : null;
  const itemsPath = user?.Id ? `/Users/${encodeURIComponent(user.Id)}/Items?${search}` : `/Items?${search}`;
  const response = await jf(credentials.base, itemsPath, credentials.token, credentials.deviceId, {
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return { ok: false, error: `Library search failed (${response.status}).` };
  const result = await response.json();
  return {
    ok: true,
    results: (result.Items || []).slice(0, 25).map((item) => ({
      id: String(item.Id || ""),
      title: String(item.Name || "Untitled"),
      artist: Array.isArray(item.Artists) ? String(item.Artists[0] || "") : String(item.AlbumArtist || ""),
      album: String(item.Album || ""),
      cover: item.Id
        ? `/v1/party/guest-image?inviteId=${encodeURIComponent(body.inviteId)}&key=${encodeURIComponent(body.key)}&trackId=${encodeURIComponent(String(item.Id))}`
        : "",
    })).filter((item) => item.id),
  };
}

async function guestSuggest(req, body) {
  const guestId = validGuestId(body.guestId);
  const trackId = String(body.trackId || "").slice(0, 80);
  const credentials = partyCredentials();
  if (!guestId || !trackId || !credentials) return { ok: false, error: "Invalid guest or track." };
  if (party.mediaQueue.some((item) => item.id === trackId)) return { ok: true, message: "Already queued." };
  const response = await jf(credentials.base, `/Items/${encodeURIComponent(trackId)}?Fields=Album,Artists,RunTimeTicks`, credentials.token, credentials.deviceId, {
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return { ok: false, error: `Track lookup failed (${response.status}).` };
  const item = await response.json();
  if (String(item.MediaType || "").toLowerCase() !== "audio" && String(item.Type || "").toLowerCase() !== "audio") {
    return { ok: false, error: "That library item is not an audio track." };
  }
  const id = String(item.Id || "");
  const title = String(item.Name || "Untitled");
  const artists = Array.isArray(item.Artists) ? item.Artists : [];
  party.mediaQueue.push({
    id,
    title,
    artist: String(artists[0] || item.AlbumArtist || ""),
    album: String(item.Album || ""),
    secs: Number(item.RunTimeTicks || 0) / 10_000_000,
    url: mediaUrl(req, credentials.base, credentials.token, credentials.deviceId, `/Audio/${encodeURIComponent(id)}/universal?Container=mp3&AudioCodec=mp3&TranscodingContainer=mp3&MaxStreamingBitrate=256000&TranscodingProtocol=http`),
    cover: mediaUrl(req, credentials.base, credentials.token, credentials.deviceId, `/Items/${encodeURIComponent(String(item.AlbumId || id))}/Images/Primary?maxWidth=600&quality=80`),
  });
  if (!party.queue.includes(id)) party.queue.push(id);
  party.queueVotes[id] = {
    score: 0,
    up: 0,
    down: 0,
    submittedAt: hrNow(),
    voters: {},
  };
  sortPartyQueue();
  partyBroadcast();
  partyMessage("QUEUE_RESORTED", { newQueue: party.queue.slice() });
  return { ok: true };
}

function partyAction(body, zoneAuthorized = false) {
  const action = String(body.action || "");
  const requester = String(body.deviceId || "").slice(0, 64);
  const targetZone = String(body.targetZone || "").trim();
  if (targetZone && targetZone.toLowerCase() !== "all") {
    const zoneActions = new Set(["play", "pause", "toggle", "seek", "next", "prev", "ended", "repeat"]);
    const requesterZone = party.zones[requester] || "Default";
    const isMember = partyMember(requester);
    const zoneHasDevices = [...devices.keys()].some((id) => partyMember(id) && (party.zones[id] || "Default") === targetZone);
    if (
      !party.on ||
      !zoneActions.has(action) ||
      !isMember ||
      (action !== "ended" && requester !== party.host) ||
      (action === "ended" && requesterZone !== targetZone) ||
      !zoneHasDevices
    ) return false;
    if (targetZone === "Default") return partyAction({ ...body, targetZone: "all" }, true);
    const globalTimeline = partyTimelineSnapshot();
    const zoneTimeline = party.zoneStates[targetZone] || partyTimelineSnapshot();
    restorePartyTimeline(zoneTimeline);
    try {
      const changed = partyAction({ ...body, targetZone: "all" }, true);
      party.zoneStates[targetZone] = partyTimelineSnapshot();
      return changed;
    } finally {
      restorePartyTimeline(globalTimeline);
    }
  }
  const now = hrNow();
  if (action === "start" || action === "load") {
    if (action === "start" && !devices.has(requester)) return false;
    if (action === "load" && requester !== party.host) return false;
    const requestedMode = body.mode === "voting" ? "voting" : "sync";
    if (action === "start" && party.on && requester !== party.host && requestedMode === party.mode) {
      if (party.mode === "sync") {
        const members = party.members.length ? party.members.slice() : [...devices.keys()];
        if (!members.includes(requester)) members.push(requester);
        party.members = cleanMembers(members, party.host);
        party.roles = { ...(party.roles || {}), [requester]: "GUEST" };
      }
      return true;
    }
    const mediaQueue = cleanMediaQueue(body.mediaQueue);
    if (mediaQueue.length) party.mediaQueue = mediaQueue;
    const queue = Array.isArray(body.queue) ? body.queue.map(String).slice(0, 2000) : [];
    party.queue = queue.length ? queue : party.mediaQueue.map((item) => item.id);
    if (action === "start") {
      if (!party.on || !party.host || requester !== party.host) party.host = requester;
      party.mode = requestedMode;
      if (party.mode === "voting") party.members = [party.host];
      else party.members = cleanMembers(body.members, party.host);
      party.roles = Object.fromEntries([...new Set([...party.members, ...devices.keys(), party.host])].filter(Boolean).map((id) => [id, id === party.host ? "HOST" : "GUEST"]));
      partyStats.clear();
      party.zoneStates = {};
      party.on = true;
      party.voterOptOut = [];
    }
    const trackId = String(body.trackId || party.trackId || party.queue[0] || "");
    if (action === "start") party.queueVotes = {};
    else party.queueVotes = Object.fromEntries(Object.entries(party.queueVotes || {}).filter(([id]) => party.queue.includes(id)));
    party.index = Math.max(0, party.queue.indexOf(trackId));
    party.trackId = party.queue[party.index] || trackId;
    party.anchorPos = Math.max(0, Number(body.position || 0));
    party.anchorAt = now + PARTY_TRACK_LEAD_MS;
    party.playing = body.playing !== false && Boolean(party.trackId);
    sortPartyQueue();
    if (body.repeat) party.repeat = String(body.repeat);
    return true;
  }
  if (action === "zone") {
    const targetId = String(body.target || "").slice(0, 64);
    const zone = String(body.zone || "").trim().slice(0, 40);
    if (requester !== party.host || !targetId || !partyMember(targetId) || !devices.has(targetId)) return false;
    if (zone) party.zones[targetId] = zone;
    else delete party.zones[targetId];
    return true;
  }
  if (action === "reaction") {
    const emoji = String(body.emoji || "");
    const allowed = new Set(["\u{1F525}", "\u{1F483}", "\u2764\uFE0F", "\u{1F44F}"]);
    if (!party.on || !devices.has(requester) || !allowed.has(emoji)) return false;
    const zone = String(body.zone || "all").trim().slice(0, 40) || "all";
    const targets = zone === "all"
      ? undefined
      : [...new Set([
          ...[...devices.keys()].filter((id) => partyMember(id) && (party.zones[id] || "Default") === zone),
          party.host,
          requester,
        ].filter((id) => devices.has(id)))];
    if (targets?.length === 0) return false;
    partyMessage("PARTY_REACTION", {
      reaction: { id: `${now}-${requester}`, emoji, from: String(devices.get(requester)?.name || "Guest").slice(0, 40), at: now },
      zone,
    }, targets);
    return true;
  }
  if (action === "report") {
    const id = requester;
    if (id) {
      const num = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null);
      partyStats.set(id, {
        drift: num(body.drift) ?? 0,
        rtt: num(body.rtt) ?? 0,
        status: String(body.status || "").slice(0, 60),
        state: String(body.state || "").slice(0, 20),
        rate: num(body.rate),
        offset: num(body.offset),
        position: num(body.position),
        buffered: num(body.buffered),
        latency: num(body.latency),
        trackId: String(body.trackId || "").slice(0, 80),
        platform: String(body.platform || "").slice(0, 20),
        resyncs: Number(body.resyncs || 0) || 0,
        at: hrNow(),
      });
    }
    return false;
  }
  if (!party.on) return false;
  if (action === "voter-opt-out" || action === "voter-opt-in") {
    if (!devices.has(requester)) return false;
    party.voterOptOut = party.voterOptOut.filter((id) => id !== requester);
    if (action === "voter-opt-out") party.voterOptOut.push(requester);
    return true;
  }
  if (action === "vote") {
    const trackId = String(body.trackId || "");
    const userId = requester;
    const voteValue = Number(body.vote);
    if (!trackId || !partyVoter(userId) || !party.queue.includes(trackId)) return false;
    return castVote(trackId, userId, voteValue, now);
  }
  if (action === "suggest") {
    const item = cleanMediaQueue([body.item])[0];
    if (!partyVoter(requester) || !item || party.mediaQueue.some((entry) => entry.id === item.id)) return false;
    party.mediaQueue.push(item);
    if (!party.queue.includes(item.id)) party.queue.push(item.id);
    party.queueVotes[item.id] = { score: 0, up: 0, down: 0, submittedAt: now, voters: {} };
    sortPartyQueue();
    return true;
  }
  if (action === "role") {
    const targetId = String(body.target || body.deviceId || "").slice(0, 64);
    const role = String(body.role || "").toUpperCase() === "HOST" ? "HOST" : "GUEST";
    if (
      requester !== party.host ||
      !targetId ||
      (targetId !== party.host && !partyMember(targetId)) ||
      (role === "GUEST" && targetId === party.host)
    ) return false;
    const nextRoles = { ...(party.roles || {}) };
    if (role === "HOST") {
      nextRoles[targetId] = "HOST";
      if (party.host && party.host !== targetId) nextRoles[party.host] = "GUEST";
      party.host = targetId;
    } else {
      nextRoles[targetId] = "GUEST";
    }
    party.roles = nextRoles;
    return true;
  }
  if (action === "join" || action === "leave") {
    const id = String(body.target || body.deviceId || "").slice(0, 64);
    if (!devices.has(requester) || !id || !devices.has(id) || (id !== requester && requester !== party.host)) return false;
    const list = party.members.length ? party.members.slice() : [...devices.keys()];
    if (action === "join") {
      if (list.includes(id)) return false;
      list.push(id);
      party.members = cleanMembers(list, party.host);
      party.roles = { ...(party.roles || {}), [id]: "GUEST" };
      return true;
    }
    if (!list.includes(id)) return false;
    const remaining = list.filter((member) => member !== id);
    if (id === party.host) {
      const eligible = [
        ...remaining,
        ...[...devices.keys()].filter((member) => member !== id && !remaining.includes(member)),
      ];
      const successor = eligible.find((member) => devices.has(member));
      if (!successor) {
        const wasPlaying = party.playing;
        const oldMembers = remaining.slice();
        party.anchorPos = partyPosition(now);
        party.anchorAt = now;
        party.on = false;
        party.host = "";
        party.members = [];
        party.playing = wasPlaying;
        partyInvites.clear();
        clearTimeout(partyTimer);
        setTimeout(() => {
          for (const deviceId of new Set([...oldMembers, id])) stopDevice(deviceId);
        }, 300);
        return true;
      }
      party.host = successor;
      if (party.mode === "voting") remaining.splice(0, remaining.length, successor);
      else if (!remaining.includes(successor)) remaining.push(successor);
    }
    party.members = cleanMembers(remaining, party.host);
    party.roles = { ...(party.roles || {}), [id]: "GUEST", [party.host]: "HOST" };
    setTimeout(() => stopDevice(id), 300);
    return true;
  }
  if (requester !== party.host && !(action === "ended" && zoneAuthorized) && action !== "stop") return false;
  if (action === "remove") {
    const trackId = String(body.trackId || "");
    if (!trackId || trackId === party.trackId || !party.queue.includes(trackId)) return false;
    party.queue = party.queue.filter((id) => id !== trackId);
    party.mediaQueue = party.mediaQueue.filter((item) => item.id !== trackId);
    delete party.queueVotes[trackId];
    party.index = party.queue.indexOf(party.trackId);
    return true;
  }
  if (action === "reorder") {
    const trackId = String(body.trackId || "");
    if (!trackId || trackId === party.trackId || !party.queue.includes(trackId)) return false;
    const from = party.queue.indexOf(trackId);
    const firstUpcoming = Math.max(1, party.queue.indexOf(party.trackId) + 1);
    const to = Math.max(firstUpcoming, Math.min(party.queue.length - 1, Math.floor(Number(body.index) || 0)));
    if (from === to) return false;
    party.queue.splice(from, 1);
    party.queue.splice(to, 0, trackId);
    party.index = party.queue.indexOf(party.trackId);
    return true;
  }
  if (action === "play-now") {
    const index = party.queue.indexOf(String(body.trackId || ""));
    if (index < 0 || party.queue[index] === party.trackId) return false;
    partyGo(index);
    return true;
  }
  if (action === "stop") {
    if (!party.on || !devices.has(requester)) return false;
    // Freeze the shared timeline: the current playback owner carries on from exactly here.
    const wasPlaying = party.playing;
    party.anchorPos = partyPosition(now);
    party.anchorAt = now;
    party.on = false;
    partyInvites.clear();
    party.playing = wasPlaying;
    clearTimeout(partyTimer);
    const playbackOwner = activeId && devices.has(activeId) ? activeId : party.host;
    if (playbackOwner) party.host = playbackOwner;
    const members = party.members.slice();
    setTimeout(() => {
      const pendingSources = new Set([...pendingTransfers.values()].map((pending) => pending.sourceId).filter(Boolean));
      for (const id of devices.keys()) {
        if (id !== playbackOwner && !pendingSources.has(id) && (!members.length || members.includes(id))) stopDevice(id);
      }
    }, 300);
    if (playbackOwner && devices.has(playbackOwner)) {
      activeId = playbackOwner;
      activeTrackId = party.trackId;
      savePlaybackState(playbackOwner, {
        ...(currentPlaybackState(playbackOwner) || {}),
        playing: wasPlaying,
        position: party.anchorPos,
        duration: Number(partyTrack()?.secs || 0),
      });
    }
    return true;
  }
  if (action === "play" || action === "pause" || action === "toggle") {
    const pos = partyPosition(now);
    const play = action === "toggle" ? !party.playing : action === "play";
    party.anchorPos = pos;
    party.anchorAt = now + (play ? PARTY_LEAD_MS : 0);
    party.playing = play;
    return true;
  }
  if (action === "seek") {
    party.anchorPos = Math.max(0, Number(body.position || 0));
    party.anchorAt = now + (party.playing ? PARTY_LEAD_MS : 0);
    return true;
  }
  if (action === "ended") {
    if (requester !== party.host && !zoneAuthorized) return false;
    if (String(body.trackId || "") !== party.trackId || !party.playing) return false;
    const secs = Number(partyTrack()?.secs || 0);
    if (secs > 1 && partyPosition(now) < secs - 4) return false;
    partyGo(party.index + 1);
    return true;
  }
  if (requester !== party.host) return false;
  if (action === "next") {
    partyGo(party.index + 1);
    return true;
  }
  if (action === "prev") {
    if (body.restart !== false && partyPosition(now) > 3) {
      party.anchorPos = 0;
      party.anchorAt = now + PARTY_TRACK_LEAD_MS;
      party.playing = true;
    } else partyGo(Math.max(0, party.index - 1));
    return true;
  }
  if (action === "repeat") {
    party.repeat = ["off", "all", "one"].includes(String(body.repeat)) ? String(body.repeat) : "off";
    return true;
  }
  if (action === "members") {
    // Pick participants. Devices dropped from the list go quiet; the host always stays in.
    const before = party.members.length ? party.members.slice() : [...devices.keys()];
    party.members = cleanMembers(body.members, party.host);
    if (party.members.length) {
      setTimeout(() => {
        for (const id of before) if (id !== party.host && !party.members.includes(id)) stopDevice(id);
      }, 300);
    }
    return true;
  }
  return false;
}

function playOn(target, body) {
  const sourceId = activeId;
  const transferId = String(body.transferId || "");
  const sourceTrackId = activeTrackId;
  const sourceState = currentPlaybackState(sourceId) || { playing: false, position: 0, duration: 0 };
  const targetDevice = devices.get(target);
  if (activeId && activeId !== target && !transferId) stopDevice(activeId);
  const snapshot = playbackSnapshot(body, activeTrackId);
  const command = {
    type: "PLAY",
    id: seq++,
    to: target,
    trackId: String(body.trackId || ""),
    mediaUrl: targetMediaUrl(snapshot.mediaUrl, targetDevice),
    title: snapshot.title,
    artist: snapshot.artist,
    album: snapshot.album,
    cover: snapshot.cover,
    position: snapshot.position,
    queue: snapshot.queue,
    mediaQueue: snapshot.mediaQueue.map((item) => ({ ...item, url: targetMediaUrl(item.url, targetDevice) })),
    transferId,
  };
  if (typeof body.volume === "number" && Number.isFinite(body.volume)) {
    command.volume = Math.max(0, Math.min(1, body.volume));
  }
  const previousPending = transferId ? pendingTransfers.get(transferId) : null;
  if (previousPending) clearTimeout(previousPending.timer);
  activeId = target;
  activeTrackId = command.trackId;
  playbackSnapshots.set(target, snapshot);
  savePlaybackState(target, {
    playing: !transferId,
    position: command.position,
    duration: Number(body.duration) || 0,
  });
  const bucket = devices.get(target);
  if (bucket) for (const sock of bucket.res) writeSse(sock, room(command));
  broadcast(room(null));
  if (transferId) {
    setTransferState(transferId, "target-command-sent", {
      sourceId,
      targetId: target,
      trackId: command.trackId,
      position: command.position,
      commandId: command.id,
    });
    const pending = {
      sourceId,
      sourceTrackId,
      sourceState,
      targetId: target,
      timer: setTimeout(() => restoreTransferSource(transferId, "Destination did not confirm playback in time."), 60_000),
    };
    pending.timer.unref?.();
    pendingTransfers.set(transferId, pending);
  }
}

async function resolveUserId(root, token, deviceId) {
  const cached = userByToken.get(token);
  if (cached) return cached;
  for (const path of ["/Users/Me", "/Users"]) {
    const headers = path === "/Users" ? {} : authHeaders(token, deviceId);
    const url = new URL(path, root);
    if (path === "/Users") url.searchParams.set("api_key", token);
    const res = await fetch(url, { headers });
    if (!res.ok) continue;
    const body = await res.json();
    const id = Array.isArray(body) ? body[0]?.Id : body?.Id;
    if (id) {
      userByToken.set(token, id);
      return id;
    }
  }
  return "";
}

async function pull(url, token, deviceId, mode, range) {
  const next = new URL(url);
  const headers = mode === "header" ? authHeaders(token, deviceId) : {};
  if (range) headers.Range = range;
  if (mode === "key") next.searchParams.set("api_key", token);
  let upstream = await fetch(next, { headers, redirect: "manual" });
  for (let hop = 0; hop < 3 && upstream.status >= 300 && upstream.status < 400; hop++) {
    const loc = upstream.headers.get("location");
    if (!loc) break;
    const hopUrl = new URL(loc, next);
    if (hopUrl.origin !== next.origin) break;
    if (mode === "key" && token) hopUrl.searchParams.set("api_key", token);
    upstream = await fetch(hopUrl, { headers, redirect: "manual" });
  }
  return upstream;
}

// When the relay runs on (or next to) the Jellyfin machine, talking to it over the public
// URL hairpins through the router/proxy and costs seconds per request. Find a direct
// address that answers with the same server Id and use it for proxied requests.
const fastOrigins = new Map();

async function jellyfinInfo(origin, ms) {
  try {
    const res = await fetch(`${origin}/System/Info/Public`, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    const info = await res.json();
    return info && info.Id ? info : null;
  } catch {
    return null;
  }
}

async function probeFastOrigin(origin) {
  const remote = await jellyfinInfo(origin, 10000);
  if (!remote) return null;
  const candidates = new Set(
    String(process.env.PETRIFY_LOCAL_JELLYFIN || "http://127.0.0.1:8096,http://localhost:8096")
      .split(",")
      .map((item) => item.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
  try {
    if (remote.LocalAddress) candidates.add(new URL(remote.LocalAddress).origin);
  } catch {
    /* no usable LocalAddress */
  }
  candidates.delete(origin);
  for (const candidate of candidates) {
    const local = await jellyfinInfo(candidate, 1500);
    if (local && local.Id === remote.Id) return candidate;
  }
  return null;
}

async function fastOrigin(root) {
  const key = root.origin;
  let entry = fastOrigins.get(key);
  if (!entry || Date.now() - entry.at > 10 * 60 * 1000) {
    entry = { at: Date.now(), pending: probeFastOrigin(key).catch(() => null) };
    fastOrigins.set(key, entry);
  }
  return entry.pending;
}

async function proxyJellyfin(req, res, incoming) {
  const base = incoming.searchParams.get("base") || "";
  const device = incoming.searchParams.get("device") || "petrify";
  const token = incoming.searchParams.get("token") || "";
  const path = incoming.searchParams.get("path") || "";
  let target;
  try {
    const root = new URL(base);
    if (root.protocol !== "http:" && root.protocol !== "https:") {
      res.writeHead(400);
      res.end("Bad base");
      return;
    }
    if (!path.startsWith("/") || path.startsWith("//") || !ALLOWED.some((p) => path.startsWith(p))) {
      res.writeHead(400);
      res.end("Path not allowed");
      return;
    }
    target = new URL(path, root);
    if (target.origin !== root.origin) {
      res.writeHead(400);
      res.end("Bad target");
      return;
    }
  } catch {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }
  const direct = await fastOrigin(new URL(base));
  if (direct) target = new URL(target.pathname + target.search, direct);
  if (token && path.startsWith("/Audio/") && !target.searchParams.has("UserId")) {
    const userId = await resolveUserId(target, token, device);
    if (userId) target.searchParams.set("UserId", userId);
  }
  const range = req.headers.range;
  let upstream = token
    ? await pull(target, token, device, "header", range)
    : await fetch(target, { headers: range ? { Range: range } : {}, redirect: "follow" });
  if (token && upstream.status === 401) upstream = await pull(target, token, device, "key", range);
  const headers = { "Access-Control-Allow-Origin": "*" };
  const type = upstream.headers.get("content-type");
  if (type) headers["Content-Type"] = type;
  const len = upstream.headers.get("content-length");
  if (len) headers["Content-Length"] = len;
  const contentRange = upstream.headers.get("content-range");
  if (contentRange) headers["Content-Range"] = contentRange;
  const acceptRanges = upstream.headers.get("accept-ranges");
  if (acceptRanges) headers["Accept-Ranges"] = acceptRanges;
  headers["Cache-Control"] = path.startsWith("/Audio/") ? "no-store" : "public, max-age=2592000";
  res.writeHead(upstream.status, headers);
  if (upstream.body) {
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}

async function onPost(req, res, url) {
  let body = {};
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { ok: false, error: "Bad JSON" });
    return;
  }
  if (url.pathname === "/v1/login") {
    try {
      sendJson(res, 200, await login(body, req));
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : "Could not reach Jellyfin." });
    }
    return;
  }
  if (url.pathname === "/v1/party/invite") {
    const deviceId = String(body.deviceId || "").slice(0, 64);
    if (!party.on || !deviceId || deviceId !== party.host) {
      sendJson(res, 403, { ok: false, error: "Only the active party host can create a guest invite." });
      return;
    }
    const inviteId = randomBytes(12).toString("hex");
    const key = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
    partyInvites.set(inviteId, { keyHash: createHash("sha256").update(key).digest(), expiresAt });
    for (const [id, invite] of partyInvites) if (invite.expiresAt <= Date.now()) partyInvites.delete(id);
    sendJson(res, 200, {
      ok: true,
      inviteId,
      key,
      expiresAt,
      url: absolute(req, `/party/${inviteId}?key=${encodeURIComponent(key)}`),
    });
    return;
  }
  if (url.pathname.startsWith("/v1/party/guest-")) {
    const invite = inviteFor(body);
    if (!invite) {
      sendJson(res, 403, { ok: false, error: "This guest invite is invalid or has expired." });
      return;
    }
    if (!party.on) {
      sendJson(res, 409, { ok: false, error: "This party has ended." });
      return;
    }
    if (url.pathname === "/v1/party/guest-state") {
      sendJson(res, 200, guestState(String(body.inviteId), String(body.key)));
      return;
    }
    if (url.pathname === "/v1/party/guest-search") {
      try {
        const result = await guestSearch(body);
        sendJson(res, result.ok ? 200 : 502, result);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : "Library search failed." });
      }
      return;
    }
    const guestId = validGuestId(body.guestId);
    if (!guestId) {
      sendJson(res, 400, { ok: false, error: "A valid guest session is required." });
      return;
    }
    const voter = `web:${String(body.inviteId)}:${guestId}`;
    if (url.pathname === "/v1/party/guest-vote") {
      const trackId = String(body.trackId || "").slice(0, 80);
      const changed = castVote(trackId, voter, Number(body.vote));
      if (changed) {
        partyBroadcast();
        partyMessage("QUEUE_RESORTED", { newQueue: party.queue.slice() });
      }
      sendJson(res, 200, { ok: true, changed });
      return;
    }
    if (url.pathname === "/v1/party/guest-suggest") {
      try {
        const result = await guestSuggest(req, body);
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : "Could not add that suggestion." });
      }
      return;
    }
    sendJson(res, 404, { ok: false, error: "Guest endpoint not found." });
    return;
  }
  if (url.pathname === "/v1/party") {
    const changed = partyAction(body);
    if (body.action === "report") {
      sendJson(res, 200, { ok: true, rev: party.rev, on: party.on, serverNow: hrNow() });
      return;
    }
    if (changed) {
      const zoneTarget = String(body.targetZone || "").trim();
      if ((!zoneTarget || zoneTarget.toLowerCase() === "all") && party.on &&
        ["start", "load", "play", "pause", "toggle", "seek", "next", "prev", "ended", "repeat"].includes(String(body.action || ""))) {
        for (const zone of Object.keys(party.zoneStates)) party.zoneStates[zone] = partyTimelineSnapshot();
      }
      recordDiagnostic("party-" + String(body.action || "update"), {
        deviceId: String(body.deviceId || ""),
        trackId: party.trackId,
        position: party.anchorPos,
      });
      partyBroadcast();
      if (body.action === "vote") {
        partyMessage("QUEUE_VOTE_CAST", {
          trackId: String(body.trackId || ""),
          userId: String(body.deviceId || "").slice(0, 64),
          vote: Number(body.vote),
        });
        partyMessage("QUEUE_RESORTED", { newQueue: party.queue.slice() });
      } else if (body.action === "suggest") {
        partyMessage("QUEUE_RESORTED", { newQueue: party.queue.slice() });
      } else if (body.action === "role") {
        partyMessage("PARTY_ROLE_CHANGE", {
          userId: String(body.target || body.deviceId || "").slice(0, 64),
          role: String(body.role || "").toUpperCase() === "HOST" ? "HOST" : "GUEST",
        });
      } else if (["remove", "reorder", "play-now"].includes(String(body.action || ""))) {
        partyMessage("QUEUE_RESORTED", { newQueue: party.queue.slice() });
      }
    }
    const action = String(body.action || "");
    const mutation = ["vote", "remove", "reorder", "play-now", "suggest"].includes(action);
    const partyActionNeedsFeedback = ["reaction", "voter-opt-in", "voter-opt-out", "join", "leave", "stop"].includes(action);
    if (!changed && (mutation || partyActionNeedsFeedback)) {
      const requester = String(body.deviceId || "");
      const hostOnly = ["remove", "reorder", "play-now"].includes(String(body.action || ""));
      const error = action === "reaction"
        ? !party.on
          ? "Start Party mode or Voting mode before sending reactions."
          : !devices.has(requester)
            ? "Connect this device to the same Petrify service before sending reactions."
            : "That reaction or target zone is not available."
        : action === "stop" && !devices.has(requester)
          ? "Connect this device to the current Petrify service before stopping Party mode."
        : action === "stop"
          ? "Party mode is already off."
        : ["voter-opt-in", "voter-opt-out"].includes(action) && !devices.has(requester)
          ? "Connect this device to the same Petrify service before changing voting."
          : !party.on && action !== "start"
            ? "Start Party mode or Voting mode first."
            : hostOnly && requester !== party.host
          ? "Only the host can move, remove or play queued songs."
          : body.action === "vote" && !partyVoter(requester)
            ? party.voterOptOut.includes(requester)
              ? "Voting is paused on this device. Re-enable it in the Voting tab."
              : "Connect this device to the same Petrify service before voting."
            : body.trackId === party.trackId
              ? "The currently playing song cannot be voted on or moved."
              : "The queue changed or this action has already been applied. Refresh and try again.";
      sendJson(res, 409, { ok: false, changed: false, error, party: partyPublic(requester) });
      return;
    }
    sendJson(res, 200, { ok: true, changed, party: partyPublic(String(body.deviceId || "")) });
    return;
  }
  if (url.pathname === "/v1/diagnostics") {
    const deviceId = String(body.deviceId || "").slice(0, 64);
    const event = String(body.event || "").slice(0, 80);
    if (!deviceId || !event || !devices.has(deviceId)) {
      sendJson(res, 409, { ok: false, error: "Connect this device before sending diagnostics." });
      return;
    }
    const details = body.details && typeof body.details === "object" ? body.details : {};
    const safeDetails = {};
    for (const key of ["transferId", "trackId", "targetId", "sourceId", "commandId", "position", "duration", "elapsedMs", "status", "method", "path", "httpStatus", "error"]) {
      if (details[key] !== undefined) safeDetails[key] = String(details[key]).slice(0, 240);
    }
    if (safeDetails.error) {
      safeDetails.error = safeDetails.error
        .replace(/https?:\/\/\S+/gi, "[url]")
        .replace(/([?&](?:token|api_key|apikey|password)=)[^&\s]*/gi, "$1[redacted]");
    }
    recordDiagnostic(event, { deviceId, ...safeDetails });
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname === "/v1/transfer-state") {
    const transferId = String(body.transferId || "").slice(0, 80);
    const state = transferStates.get(transferId);
    if (body.transferAck === true || body.transferAck === false) {
      const targetId = String(body.deviceId || "").slice(0, 64);
      if (!state || state.targetId !== targetId || !devices.has(targetId)) {
        sendJson(res, 409, { ok: false, error: "Transfer acknowledgement does not match a pending destination." });
        return;
      }
      if (state.status === "completed" || state.status === "failed") {
        sendJson(res, 200, { ok: true, transfer: state });
        return;
      }
      if (!body.transferAck) {
        restoreTransferSource(transferId, String(body.error || "Destination could not start playback.").slice(0, 240));
        sendJson(res, 200, { ok: true });
        return;
      }
      const pending = pendingTransfers.get(transferId);
      if (!pending || activeId !== targetId) {
        sendJson(res, 409, { ok: false, error: "This transfer is no longer active." });
        return;
      }
      clearTimeout(pending.timer);
      pendingTransfers.delete(transferId);
      if (pending.sourceId && pending.sourceId !== targetId) stopDevice(pending.sourceId, transferId);
      activeId = targetId;
      activeTrackId = state.trackId || activeTrackId;
      const targetState = playbackState.get(targetId) || { playing: true, position: 0, duration: 0 };
      savePlaybackState(targetId, {
        ...targetState,
        playing: true,
        position: Number.isFinite(Number(body.position)) ? Math.max(0, Number(body.position)) : targetState.position,
      });
      broadcast(room(null));
      setTransferState(transferId, "completed", {
        sourceId: pending.sourceId,
        targetId,
        trackId: state.trackId,
        position: Number(body.position) || 0,
      });
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 200, { ok: true, transfer: state || null });
    return;
  }
  if (url.pathname === "/api/connect-live" || url.pathname === "/v1/connect") {
    const id = String(body.deviceId || "").slice(0, 64);
    const target = String(body.transferTo || "").slice(0, 64);
    if (id && body.name && devices.has(id)) devices.get(id).name = String(body.name).slice(0, 40);
    if (body.claim) {
      if (!id || !devices.has(id) || !(body.trackId || body.mediaUrl)) {
        sendJson(res, 409, { ok: false, error: "This device is not connected or has no current track." });
        return;
      }
      // During a party every device plays on purpose, so a claim must not silence the others.
      if (activeId && activeId !== id && !party.on) {
        const previous = devices.get(activeId);
        if (previous) {
          const stop = { type: "STOP", id: seq++, to: activeId };
          for (const sock of previous.res) writeSse(sock, room(stop));
        }
      }
      activeId = id;
      activeTrackId = String(body.trackId || "");
      const snapshot = playbackSnapshot(body, activeTrackId);
      if (snapshot.mediaUrl || snapshot.mediaQueue.length) {
        playbackSnapshots.set(id, snapshot);
      } else {
        playbackSnapshots.delete(id);
      }
      savePlaybackState(id, { playing: true, position: Number(body.position) || 0, duration: Number(body.duration) || 0 });
      recordDiagnostic("playback-claimed", { deviceId: id, trackId: activeTrackId, position: Number(body.position) || 0 });
      broadcast(room(null));
      sendJson(res, 200, { ok: true, devices: listDevices(), activeId });
      return;
    }
    if (body.control) {
      const actions = new Set(["PLAY", "PAUSE", "TOGGLE", "NEXT", "PREVIOUS", "SEEK"]);
      const action = String(body.control).toUpperCase();
      const active = devices.get(activeId);
      if (!id || !devices.has(id) || !activeId || !active || !active.res.size || !actions.has(action)) {
        sendJson(res, 409, { ok: false, error: "There is no active playback device to control." });
        return;
      }
      const command = {
        type: "CONTROL",
        id: seq++,
        to: activeId,
        action,
        value: Number.isFinite(Number(body.value)) ? Number(body.value) : undefined,
      };
      for (const sock of active.res) writeSse(sock, room(command));
      recordDiagnostic("playback-control-dispatched", {
        deviceId: id,
        targetId: activeId,
        status: action,
        commandId: command.id,
      });
      sendJson(res, 200, { ok: true, activeId });
      return;
    }
    if (typeof body.playing === "boolean") {
      if (id && id === activeId && devices.has(id)) {
        savePlaybackState(id, {
          playing: body.playing,
          position: Math.max(0, Number(body.position) || 0),
          duration: Math.max(0, Number(body.duration) || 0),
        });
        freshWaiters.get(id)?.();
        if (body.trackId) {
          const reportedTrackId = String(body.trackId);
          if (reportedTrackId !== activeTrackId) {
            activeTrackId = reportedTrackId;
            const snapshot = playbackSnapshots.get(id);
            if (snapshot && snapshot.trackId !== reportedTrackId) playbackSnapshots.delete(id);
          }
        }
        recordDiagnostic("playback-state-reported", {
          deviceId: id,
          trackId: activeTrackId,
          position: Math.max(0, Number(body.position) || 0),
          status: body.playing ? "playing" : "paused",
        });
        broadcast(room(null));
      }
      sendJson(res, 200, { ok: true, devices: listDevices(), activeId });
      return;
    }
    if (id && typeof body.volume === "number" && !target && !body.trackId && !body.mediaUrl) {
      if (id === activeId) {
        const snapshot = playbackSnapshots.get(id);
        if (snapshot) {
          playbackSnapshots.set(id, {
            ...snapshot,
            volume: Math.max(0, Math.min(1, Number(body.volume))),
          });
        }
      }
      const command = {
        type: "VOLUME",
        id: seq++,
        volume: Math.max(0, Math.min(1, Number(body.volume))),
        gain: typeof body.gain === "number" ? Math.max(0, Math.min(1, body.gain)) : undefined,
      };
      for (const [devId, device] of devices) {
        if (devId === id) continue;
        for (const sock of device.res) writeSse(sock, room(command));
      }
      sendJson(res, 200, { ok: true });
      return;
    }
    if (body.snapshot) {
      if (!target || !devices.has(target) || !(body.trackId || body.mediaUrl)) {
        sendJson(res, 409, { ok: false, error: "The destination is no longer connected or the source has no current track." });
        return;
      }
      if (activeId && activeId !== target) {
        sendJson(res, 409, {
          ok: false,
          error: "An active playback source exists. Request a relay-owned transfer instead of sending a device snapshot.",
        });
        return;
      }
      if (body.transferId) setTransferState(String(body.transferId), "snapshot-received", {
        sourceId: id,
        targetId: target,
        trackId: String(body.trackId || ""),
        position: Number(body.position) || 0,
      });
      playOn(target, body);
      sendJson(res, 200, { ok: true, devices: listDevices(), activeId });
      return;
    }
    if (body.pull) {
      const source = devices.get(activeId);
      const destination = devices.get(target);
      if (!target || target === activeId || !destination?.res.size || !activeId || !source?.res.size) {
        sendJson(res, 409, {
          ok: false,
          error: "Playback transfer needs a connected source and a connected, different destination.",
        });
        return;
      }
      const transferId = String(body.transferId || `transfer-${Date.now().toString(36)}-${seq}`).slice(0, 80);
      await requestFreshState(activeId);
      const cachedSnapshot = playbackSnapshots.get(activeId);
      if (!cachedSnapshot || (!cachedSnapshot.mediaUrl && !cachedSnapshot.mediaQueue.length)) {
        recordDiagnostic("transfer-snapshot-missing", {
          transferId,
          sourceId: activeId,
          targetId: target,
          trackId: activeTrackId,
        });
        sendJson(res, 409, {
          ok: false,
          error: "The active player has not registered a playable track yet. Start playback on the updated app, then try again.",
        });
        return;
      }
      const state = currentPlaybackState(activeId);
      const snapshot = {
        ...cachedSnapshot,
        trackId: activeTrackId || cachedSnapshot.trackId,
        position: state?.position ?? cachedSnapshot.position,
        duration: state?.duration || cachedSnapshot.duration,
        transferTo: target,
        transferId,
      };
      setTransferState(transferId, "requested", {
        sourceId: activeId,
        targetId: target,
        trackId: snapshot.trackId,
        position: snapshot.position,
        delivery: "cached-snapshot",
      });
      setTransferState(transferId, "snapshot-received", {
        sourceId: activeId,
        targetId: target,
        trackId: snapshot.trackId,
        position: snapshot.position,
      });
      playOn(target, snapshot);
      sendJson(res, 200, { ok: true, pulled: true, transferId, delivery: "cached-snapshot", devices: listDevices(), activeId });
      return;
    }
    if (target && devices.get(target)?.res.size && activeId && activeId !== target) {
      sendJson(res, 409, {
        ok: false,
        error: "An active playback source exists. Request a relay-owned transfer instead of sending a device snapshot.",
      });
      return;
    }
    if (target && devices.get(target)?.res.size && (body.trackId || body.mediaUrl)) playOn(target, body);
    else broadcast(room(null));
    const ok = Boolean(target && devices.get(target)?.res.size && (body.trackId || body.mediaUrl));
    if (!ok) recordDiagnostic("play-request-rejected", { deviceId: id, targetId: target, reason: "Target is not connected or track data is missing." });
    sendJson(res, 200, { ok, error: ok ? undefined : "Target is not connected or track data is missing.", devices: listDevices(), activeId });
    return;
  }
  sendJson(res, 404, { ok: false, error: "Not found" });
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/health") {
    sendJson(res, 200, { ok: true, service: "petrify", version: RELAY_VERSION, connectProtocol: 8, capabilities: ["queue-voting", "queue-management", "independent-voting", "party-reactions"], party: party.on, devices: listDevices() });
    return;
  }
  const guestPage = /^\/party\/([a-f0-9]{24})$/.exec(url.pathname);
  if (req.method === "GET" && guestPage) {
    const inviteId = guestPage[1];
    if (!inviteFor({ inviteId, key: url.searchParams.get("key") })) {
      sendJson(res, 403, { ok: false, error: "This guest invite is invalid or has expired." });
      return;
    }
    void readFile(new URL("./party-guest.html", import.meta.url)).then((html) => {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      });
      res.end(html);
    }).catch((error) => {
      console.error(`Guest page could not be loaded: ${error instanceof Error ? error.message : "read failed"}`);
      sendJson(res, 500, { ok: false, error: "Guest page is unavailable." });
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/party/guest-events") {
    const streamData = {
      inviteId: String(url.searchParams.get("inviteId") || ""),
      key: String(url.searchParams.get("key") || ""),
    };
    const invite = inviteFor(streamData);
    if (!invite) {
      sendJson(res, 403, { ok: false, error: "This guest invite is invalid or has expired." });
      return;
    }
    if (!party.on) {
      sendJson(res, 409, { ok: false, error: "This party has ended." });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Referrer-Policy": "no-referrer",
    });
    const stream = {
      res,
      inviteId: streamData.inviteId,
      key: streamData.key,
      expiresAt: invite.expiresAt,
      keepalive: null,
    };
    writeSse(res, guestState(stream.inviteId, stream.key));
    stream.keepalive = setInterval(() => {
      if (Date.now() >= stream.expiresAt) {
        clearInterval(stream.keepalive);
        partyGuestStreams.delete(stream);
        res.end();
        return;
      }
      if (!res.destroyed) res.write(": keep-alive\n\n");
    }, 15_000);
    partyGuestStreams.add(stream);
    res.on("close", () => {
      clearInterval(stream.keepalive);
      partyGuestStreams.delete(stream);
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/party/guest-image") {
    const params = {
      inviteId: url.searchParams.get("inviteId"),
      key: url.searchParams.get("key"),
    };
    if (!inviteFor(params)) {
      sendJson(res, 403, { ok: false, error: "This guest invite is invalid or has expired." });
      return;
    }
    const trackId = String(url.searchParams.get("trackId") || "");
    const credentials = partyCredentials();
    if (!party.on || !/^[a-zA-Z0-9_-]{1,80}$/.test(trackId) || !credentials) {
      res.writeHead(404);
      res.end();
      return;
    }
    void (async () => {
      try {
        const path = `/Items/${encodeURIComponent(trackId)}/Images/Primary?maxWidth=600&quality=80`;
        const upstream = await jf(credentials.base, path, credentials.token, credentials.deviceId, { signal: AbortSignal.timeout(8000) });
        if (!upstream.ok) {
          res.writeHead(upstream.status);
          res.end();
          return;
        }
        const data = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(200, {
          "Content-Type": upstream.headers.get("content-type") || "image/jpeg",
          "Content-Length": data.length,
          "Cache-Control": "private, max-age=300",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(data);
      } catch {
        res.writeHead(502);
        res.end();
      }
    })();
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/time") {
    cors(res);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ now: hrNow() }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/party") {
    const deviceId = String(url.searchParams.get("device") || "").slice(0, 64);
    sendJson(res, 200, { ok: true, party: partyPublic(deviceId) });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/diagnostics") {
    sendJson(res, 200, {
      events: diagnosticEvents.slice(-200).reverse(),
      transfers: [...transferStates.values()].reverse(),
      devices: listDevices(),
      activeId,
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/transfer-state") {
    const transferId = String(url.searchParams.get("transferId") || "").slice(0, 80);
    sendJson(res, 200, { ok: true, transfer: transferStates.get(transferId) || null });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/devices") {
    sendJson(res, 200, { devices: listDevices(), activeId });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/jf") {
    proxyJellyfin(req, res, url).catch((err) => {
      res.writeHead(502);
      res.end(err instanceof Error ? err.message : "Proxy failed");
    });
    return;
  }
  if (req.method === "GET" && (url.pathname === "/api/connect-live" || url.pathname === "/v1/connect")) {
    const id = (url.searchParams.get("device") || "").slice(0, 64);
    const name = (url.searchParams.get("name") || "Petrify").slice(0, 40);
    const kind = ["phone", "tablet", "laptop", "desktop"].includes(url.searchParams.get("kind") || "") ? url.searchParams.get("kind") : "";
    if (!id) {
      res.writeHead(400);
      res.end("device required");
      return;
    }
    cors(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(": open\n\n");
    const keepalive = setInterval(() => {
      if (!res.destroyed) res.write(": keep-alive\n\n");
    }, 15_000);
    let bucket = devices.get(id);
    if (!bucket) {
      bucket = { id, name, origin: "", res: new Set() };
      devices.set(id, bucket);
    }
    bucket.name = name;
    if (kind) bucket.kind = kind;
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const protocol = forwardedProto === "https" ? "https" : req.socket.encrypted ? "https" : "http";
    bucket.origin = `${protocol}://${req.headers.host || `127.0.0.1:${PORT}`}`;
    bucket.res.add(res);
    recordDiagnostic("device-connected", { deviceId: id, name });
    broadcast(room(null));
    if (party.on) writeSse(res, room({ type: "PARTY", party: partyPublic(id) }));
    res.on("close", () => {
      clearInterval(keepalive);
      bucket.res.delete(res);
      if (!bucket.res.size) {
        recordDiagnostic("device-disconnected", { deviceId: id });
        devices.delete(id);
        if (activeId === id) {
          activeId = "";
          activeTrackId = "";
          playbackState.delete(id);
        }
        broadcast(room(null));
      }
    });
    return;
  }
  if (req.method === "POST") {
    onPost(req, res, url);
    return;
  }
  sendJson(res, 404, { ok: false, error: "Not found" });
});

function ipv4Number(address) {
  return address.split(".").reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function addressForClient(remoteAddress) {
  const client = ipv4Number(remoteAddress);
  const addresses = Object.values(networkInterfaces()).flatMap((entries) => entries || []);
  const ipv4 = addresses.filter((item) => (item.family === "IPv4" || item.family === 4) && !item.internal);
  const match = ipv4.find(
    (item) => (ipv4Number(item.address) & ipv4Number(item.netmask)) === (client & ipv4Number(item.netmask)),
  );
  return match?.address || ipv4[0]?.address || "";
}

const discovery = createSocket("udp4");
discovery.on("message", (message, remote) => {
  if (message.toString() !== "PETRIFY_DISCOVER_V1") return;
  const host = addressForClient(remote.address);
  if (!host) return;
  const response = Buffer.from(`PETRIFY_SERVICE_V1|${host}|${PORT}|${PLAYER_PORT}`);
  discovery.send(response, remote.port, remote.address);
});
discovery.on("error", (error) => {
  console.error(`LAN discovery failed on UDP ${DISCOVERY_PORT}: ${error.message}`);
});
discovery.bind(DISCOVERY_PORT, "0.0.0.0");

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Petrify service listening on http://0.0.0.0:${PORT}`);
  console.log(`LAN discovery listening on UDP ${DISCOVERY_PORT}`);
});
