const { WebSocketServer } = require('ws');
const rooms = require('./rooms');
const store = require('./store');

function attachWebSocket(server, sessionParser) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    sessionParser(req, {}, () => {
      if (!req.session || !req.session.user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
  });

  wss.on('connection', (ws, req) => {
    const username = req.session.user;
    ws.__username = username;
    let joinedRoom = null;

    const send = (obj) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    };

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        return;
      }
      try {
        if (msg.type === 'subscribe') {
          const room = rooms.getRoom(msg.room);
          if (!room) return send({ type: 'error', message: 'room_not_found' });
          if (!room.teams.some((t) => t.members.includes(username))) {
            return send({ type: 'error', message: 'not_in_room' });
          }
          if (joinedRoom) joinedRoom.sockets.delete(ws);
          joinedRoom = room;
          room.sockets.add(ws);
          send({ type: 'state', state: rooms.publicState(room, username) });
          return;
        }

        if (!joinedRoom) return send({ type: 'error', message: 'not_subscribed' });

        // Audio transport is a lightweight side channel, not game state: it
        // never touches rooms.js and never triggers a full state broadcast.
        if (msg.type === 'audioRequest') {
          // A non-host device's Play/Pause tap — relay it to the host's own
          // socket(s) so THEIR browser actually starts/stops playback.
          if (joinedRoom.audioHost && joinedRoom.audioHost !== username) {
            const action = msg.action === 'pause' ? 'pause' : 'play';
            const payload = JSON.stringify({ type: 'audioCommand', action });
            for (const sock of joinedRoom.sockets) {
              if (sock.__username === joinedRoom.audioHost && sock.readyState === 1) sock.send(payload);
            }
          }
          return;
        }
        if (msg.type === 'audioState') {
          // The host device reporting what it's actually doing — relay to
          // everyone else so their Play/Pause icon stays accurate.
          if (joinedRoom.audioHost === username) {
            const payload = JSON.stringify({ type: 'audioState', playing: !!msg.playing });
            for (const sock of joinedRoom.sockets) {
              if (sock !== ws && sock.readyState === 1) sock.send(payload);
            }
          }
          return;
        }

        if (msg.type === 'start') rooms.startGame(joinedRoom, username);
        else if (msg.type === 'switchTeam') rooms.switchTeam(joinedRoom, username, msg.teamId);
        else if (msg.type === 'selectPlaylists') {
          const playlists = (Array.isArray(msg.playlistIds) ? msg.playlistIds : [])
            .map((id) => store.getPlaylist(id))
            .filter((p) => p && (p.status || 'ready') === 'ready');
          rooms.setPlayerPlaylists(joinedRoom, username, playlists);
        }
        else if (msg.type === 'setAudioHost') rooms.setAudioHost(joinedRoom, username, !!msg.enable);
        else if (msg.type === 'draw') rooms.draw(joinedRoom, username);
        else if (msg.type === 'pickGap') rooms.pickGap(joinedRoom, username, msg.gap);
        else if (msg.type === 'placeCard') rooms.placeCard(joinedRoom, username, rooms.broadcast);
        else if (msg.type === 'stealIntent') rooms.stealIntent(joinedRoom, username, !!msg.wants, rooms.broadcast);
        else if (msg.type === 'challenge') rooms.challenge(joinedRoom, username, msg.gap, rooms.broadcast);
        else if (msg.type === 'claimBonus') rooms.claimBonus(joinedRoom, username, !!msg.claim);
        else if (msg.type === 'submitBonusGuess') rooms.submitBonusGuess(joinedRoom, username, msg.artist, msg.title);
        else if (msg.type === 'castBonusVote') rooms.castBonusVote(joinedRoom, username, !!msg.correct, rooms.broadcast);
        else if (msg.type === 'next') rooms.next(joinedRoom, username);
        else return;

        rooms.broadcast(joinedRoom);
      } catch (e) {
        send({ type: 'error', message: e.code || 'error' });
      }
    });

    ws.on('close', () => {
      if (!joinedRoom) return;
      joinedRoom.sockets.delete(ws);
      // The audio-host device's socket dropped — don't release the role
      // immediately, a routine reconnect (screen lock, brief network blip)
      // is the common case; rooms.js waits out a grace period first and
      // only actually clears it if the device never comes back.
      rooms.scheduleAudioHostGraceCheck(joinedRoom, username, rooms.broadcast);
    });
  });

  return wss;
}

module.exports = attachWebSocket;
