(function () {
  'use strict';

  function randomId(prefix) {
    if (window.crypto && window.crypto.getRandomValues) {
      const bytes = new Uint8Array(8);
      window.crypto.getRandomValues(bytes);
      return prefix + Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    }
    return prefix + Math.random().toString(36).slice(2, 18);
  }

  const DEPLOYED_SERVER_URL = '';

  function configuredServerUrl() {
    const params = new URLSearchParams(window.location.search);
    const fromLink = params.get('server');
    let saved = '';
    try { saved = localStorage.getItem('99drop-server-url') || ''; } catch (_) {}
    const explicit = fromLink || window.NINETY_NINE_DROP_SERVER_URL || DEPLOYED_SERVER_URL || saved;
    if (explicit) return explicit.trim().replace(/\/+$/, '');
    if (window.location.protocol === 'file:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      return 'ws://localhost:8787/ws';
    }
    return '';
  }

  window.NINETY_NINE_DROP_SERVER_URL = configuredServerUrl();

  class DataConnection {
    constructor(owner, remoteId) {
      this.peer = remoteId;
      this.open = false;
      this._owner = owner;
      this._events = Object.create(null);
      this._queuedData = [];
      this._closed = false;
    }

    on(eventName, callback) {
      (this._events[eventName] || (this._events[eventName] = [])).push(callback);
      if (eventName === 'data' && this._queuedData.length) {
        const waiting = this._queuedData.splice(0);
        queueMicrotask(() => waiting.forEach((data) => this._emit('data', data)));
      }
      return this;
    }

    _emit(eventName, value) {
      const listeners = this._events[eventName] || [];
      if (eventName === 'data' && listeners.length === 0) {
        this._queuedData.push(value);
        return;
      }
      listeners.forEach((listener) => {
        try { listener(value); } catch (error) { console.error(error); }
      });
    }

    send(data) {
      if (!this.open || this._closed) throw new Error('Lobby connection is not open.');
      this._owner._send({ type: 'data', to: this.peer, data: data });
    }

    close() {
      if (this._closed) return;
      this._closed = true;
      this.open = false;
      this._owner._send({ type: 'close-peer', to: this.peer });
      this._emit('close');
      this._owner._connections.delete(this.peer);
    }
  }

  class Peer {
    constructor(id) {
      this.id = id || randomId('player-');
      this._events = Object.create(null);
      this._connections = new Map();
      this._queuedConnects = [];
      this._ready = false;
      this._socket = null;
      this._pingTimer = null;

      const serverUrl = window.NINETY_NINE_DROP_SERVER_URL;
      if (!serverUrl || typeof WebSocket === 'undefined') {
        queueMicrotask(() => this._emit('error', new Error('Multiplayer server is not configured yet.')));
        return;
      }

      try {
        this._socket = new WebSocket(serverUrl);
      } catch (error) {
        queueMicrotask(() => this._emit('error', error));
        return;
      }

      this._socket.addEventListener('open', () => {
        this._send({ type: 'register', id: this.id });
      });
      this._socket.addEventListener('message', (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch (_) { return; }
        this._handle(message);
      });
      this._socket.addEventListener('error', () => {
        this._emit('error', new Error('Could not reach the multiplayer server.'));
      });
      this._socket.addEventListener('close', () => {
        if (this._pingTimer) clearInterval(this._pingTimer);
        this._connections.forEach((connection) => {
          connection.open = false;
          connection._closed = true;
          connection._emit('close');
        });
        this._emit('disconnected');
      });
      this._pingTimer = setInterval(() => {
        this._send({ type: 'ping' });
      }, 25000);
    }

    on(eventName, callback) {
      (this._events[eventName] || (this._events[eventName] = [])).push(callback);
      if (eventName === 'open' && this._ready) queueMicrotask(() => callback(this.id));
      return this;
    }

    _emit(eventName, value) {
      (this._events[eventName] || []).forEach((listener) => {
        try { listener(value); } catch (error) { console.error(error); }
      });
    }

    _send(message) {
      if (this._socket && this._socket.readyState === WebSocket.OPEN) {
        this._socket.send(JSON.stringify(message));
      }
    }

    _connection(remoteId) {
      let connection = this._connections.get(remoteId);
      if (!connection) {
        connection = new DataConnection(this, remoteId);
        this._connections.set(remoteId, connection);
      }
      return connection;
    }

    _handle(message) {
      if (message.type === 'registered') {
        this.id = message.id;
        this._ready = true;
        this._emit('open', this.id);
        this._queuedConnects.splice(0).forEach((connection) => this._startConnect(connection));
        return;
      }
      if (message.type === 'incoming') {
        const connection = this._connection(message.from);
        connection.open = true;
        this._emit('connection', connection);
        return;
      }
      if (message.type === 'connected') {
        const connection = this._connection(message.peer);
        connection.open = true;
        connection._emit('open');
        return;
      }
      if (message.type === 'data') {
        const connection = this._connections.get(message.from);
        if (connection) connection._emit('data', message.data);
        return;
      }
      if (message.type === 'peer-closed') {
        const connection = this._connections.get(message.peer);
        if (connection) {
          connection.open = false;
          connection._closed = true;
          connection._emit('close');
          this._connections.delete(message.peer);
        }
        return;
      }
      if (message.type === 'connect-error') {
        const connection = this._connections.get(message.peer);
        if (connection) {
          if (message.reason === 'full') connection._emit('data', { type: 'full' });
          else connection._emit('error', new Error(message.reason || 'Could not join lobby.'));
        } else {
          this._emit('error', new Error(message.reason || 'Could not join lobby.'));
        }
        return;
      }
      if (message.type === 'error') {
        this._emit('error', new Error(message.message || 'Multiplayer connection error.'));
      }
    }

    connect(remoteId) {
      const connection = this._connection(remoteId);
      if (this._ready) this._startConnect(connection);
      else this._queuedConnects.push(connection);
      return connection;
    }

    _startConnect(connection) {
      this._send({ type: 'connect', to: connection.peer });
    }

    destroy() {
      if (this._pingTimer) clearInterval(this._pingTimer);
      if (this._socket && this._socket.readyState < WebSocket.CLOSING) this._socket.close();
    }
  }

  window.Peer = Peer;
})();