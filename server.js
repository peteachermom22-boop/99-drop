'use strict';

const http = require('node:http');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8787);
const MAX_PLAYERS = 10;
const MAX_MESSAGES_PER_SECOND = 120;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const peers = new Map();
const rooms = new Map();

function jsonReply(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/healthz')) {
    return jsonReply(response, 200, {
      ok: true,
      service: '99-drop-multiplayer',
      connectedPlayers: peers.size,
      activeRooms: rooms.size
    });
  }
  jsonReply(response, 404, { error: 'Not found' });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const origin = request.headers.origin || '';
  if (allowed.length && origin && origin !== 'null' && !allowed.includes(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (websocket) => {
    wss.emit('connection', websocket, request);
  });
});

function send(websocket, message) {
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify(message));
  }
}

function sendError(websocket, message) {
  send(websocket, { type: 'error', message: message });
}

function validPeerId(value) {
  return typeof value === 'string' && /^[a-z0-9-]{4,64}$/i.test(value);
}

function hostOnlyMessage(type) {
  return type === 'start' ||
    type === 'winner' ||
    type === 'admin-kill-all' ||
    type === 'admin-storm' ||
    type === 'admin-granted';
}

function unlinkPeer(peer) {
  if (!peer || !peer.id) return;
  peers.delete(peer.id);

  if (peer.isHost) {
    const room = rooms.get(peer.id);
    if (room) {
      room.guests.forEach((guestId) => {
        const guest = peers.get(guestId);
        if (guest) {
          guest.roomId = '';
          send(guest.socket, { type: 'peer-closed', peer: peer.id });
        }
      });
      rooms.delete(peer.id);
    }
    return;
  }

  const room = peer.roomId ? rooms.get(peer.roomId) : null;
  if (room) {
    room.guests.delete(peer.id);
    const host = peers.get(room.hostId);
    if (host) send(host.socket, { type: 'peer-closed', peer: peer.id });
  }
}

function connectPeer(peer, targetId) {
  if (!peer.id) return sendError(peer.socket, 'Connect to the multiplayer service again.');
  if (peer.isHost) return sendError(peer.socket, 'A lobby host cannot join another lobby.');
  if (peer.roomId) return sendError(peer.socket, 'You are already in a lobby.');

  const room = rooms.get(targetId);
  const host = peers.get(targetId);
  if (!room || !host || !host.isHost || host.socket.readyState !== WebSocket.OPEN) {
    return send(peer.socket, { type: 'connect-error', peer: targetId, reason: 'not-found' });
  }

  if (room.guests.size >= MAX_PLAYERS - 1) {
    return send(peer.socket, { type: 'connect-error', peer: targetId, reason: 'full' });
  }

  room.guests.add(peer.id);
  peer.roomId = targetId;
  host.guests.add(peer.id);
  send(host.socket, { type: 'incoming', from: peer.id });
  send(peer.socket, { type: 'connected', peer: targetId });
}

function relayData(peer, message) {
  const targetId = message.to;
  const target = peers.get(targetId);
  const payload = message.data;
  if (!target || !payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  if (typeof payload.type !== 'string' || payload.type.length > 40) return;

  const roomId = peer.isHost ? peer.id : peer.roomId;
  const room = roomId ? rooms.get(roomId) : null;
  if (!room) return;

  const related = peer.isHost
    ? room.guests.has(targetId)
    : target.isHost && target.id === room.hostId && room.guests.has(peer.id);
  if (!related) return;

  if (!peer.isHost && hostOnlyMessage(payload.type)) {
    sendError(peer.socket, 'Only the lobby host can use that control.');
    return;
  }

  send(target.socket, { type: 'data', from: peer.id, data: payload });
}

function handleMessage(peer, message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;

  if (message.type === 'ping') {
    send(peer.socket, { type: 'pong' });
    return;
  }

  if (message.type === 'register') {
    if (peer.id) return sendError(peer.socket, 'This connection is already registered.');
    if (!validPeerId(message.id)) return sendError(peer.socket, 'The player ID was invalid.');
    if (peers.has(message.id)) return sendError(peer.socket, 'That lobby code is already in use.');

    peer.id = message.id;
    peer.isHost = message.id.startsWith('drop-');
    if (peer.isHost) {
      peer.guests = new Set();
      rooms.set(peer.id, { hostId: peer.id, guests: peer.guests });
    } else {
      peer.roomId = '';
    }
    peers.set(peer.id, peer);
    send(peer.socket, { type: 'registered', id: peer.id });
    return;
  }

  if (!peer.id) return sendError(peer.socket, 'Connect to the multiplayer service first.');

  if (message.type === 'connect') {
    if (!validPeerId(message.to)) return sendError(peer.socket, 'That lobby code is invalid.');
    connectPeer(peer, message.to);
    return;
  }

  if (message.type === 'data') {
    relayData(peer, message);
    return;
  }

  if (message.type === 'close-peer') {
    if (peer.isHost) {
      const room = rooms.get(peer.id);
      const guest = peers.get(message.to);
      if (room && guest && guest.roomId === peer.id) {
        room.guests.delete(guest.id);
        guest.roomId = '';
        send(guest.socket, { type: 'peer-closed', peer: peer.id });
      }
    } else if (peer.roomId) {
      const host = peers.get(peer.roomId);
      const room = rooms.get(peer.roomId);
      const oldHostId = peer.roomId;
      if (room) room.guests.delete(peer.id);
      peer.roomId = '';
      if (host) send(host.socket, { type: 'peer-closed', peer: peer.id });
      send(peer.socket, { type: 'peer-closed', peer: oldHostId });
    }
  }
}

wss.on('connection', (websocket) => {
  const peer = {
    id: '',
    socket: websocket,
    isHost: false,
    roomId: '',
    guests: null,
    messageWindow: Date.now(),
    messageCount: 0,
    isAlive: true
  };

  websocket.isAlive = true;
  websocket.on('pong', () => { peer.isAlive = true; websocket.isAlive = true; });
  websocket.on('message', (raw) => {
    const now = Date.now();
    if (now - peer.messageWindow >= 1000) {
      peer.messageWindow = now;
      peer.messageCount = 0;
    }
    peer.messageCount += 1;
    if (peer.messageCount > MAX_MESSAGES_PER_SECOND) {
      websocket.close(1008, 'Message rate limit exceeded');
      return;
    }

    let message;
    try { message = JSON.parse(raw.toString()); } catch (_) { return; }
    handleMessage(peer, message);
  });
  websocket.on('close', () => unlinkPeer(peer));
  websocket.on('error', () => unlinkPeer(peer));
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((websocket) => {
    if (websocket.isAlive === false) {
      websocket.terminate();
      return;
    }
    websocket.isAlive = false;
    websocket.ping();
  });
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('99 Drop multiplayer server listening on port ' + PORT);
});

function shutDown() {
  clearInterval(heartbeat);
  wss.clients.forEach((websocket) => websocket.close(1001, 'Server shutting down'));
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutDown);
process.on('SIGINT', shutDown);
