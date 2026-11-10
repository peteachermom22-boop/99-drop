# 99 Drop — Battle Royale

99 Drop is a browser game with solo bot matches and friends lobbies. The game page and multiplayer service are separate: GitHub Pages serves the page, while the Node server keeps room connections moving between players.

## Features kept in the game

- Solo matches against bots, with Meadow, City, Forest, Desert, and Snow maps.
- Buildable walls, shrinking storm, automatic fire while held, custom key binds, and fullscreen.
- 3D and 2D views.
- Wins, win streaks, kill counts, weapon rewards, and the Mythic milestone.
- Admin panel, admin sword, speed control, and the friends lobby.
- Up to 10 players in a room.

## Run the multiplayer server

The server needs Node.js 20 or newer.

1. In this folder, run \`npm install\`.
2. Run \`npm start\`.
3. The server listens on port 8787 by default and answers at \`/healthz\`.
4. The browser connects to \`ws://localhost:8787/ws\` when the game is opened locally.

To host the server online, create a Node web service from this repository. For example, Render's setup uses build command \`npm install\` and start command \`npm start\`. The service URL will look like \`https://your-service.onrender.com\`; the game uses the secure WebSocket address \`wss://your-service.onrender.com/ws\`.

After you have the server URL, put that full WebSocket address in \`DEPLOYED_SERVER_URL\` near the top of \`peer-client.js\`, then commit that update. You can also pass a server address in the invite link; the lobby's Copy invite button includes it automatically.

Free hobby servers may sleep after a period without visitors, so the first connection after a long break can take a little while. Render's current [free-service notes](https://render.com/docs/free) describe those limits.

## Publish the game page

1. Make this repository public if you're using GitHub Free. GitHub's [Pages guide](https://docs.github.com/en/pages/getting-started-with-github-pages) lists which plans support Pages from private repositories.
2. Open repository **Settings → Pages**.
3. Choose **Deploy from a branch**, then choose **main** and **/(root)**.
4. Open the address GitHub Pages provides. The home page and lobby let players create or join rooms.

## Friends match

1. The host opens **Friends lobby** and chooses **Create lobby**.
2. The host shares the invite link or room code.
3. Friends open the same game page, enter their names, and join.
4. The host starts the match after friends join.

## What the server does not save

Rooms are temporary and disappear when their host disconnects. Wins, kills, streaks, and unlocked weapons remain in each player's browser storage. This relay server enforces the 10-player room limit and host-only lobby controls, but it does not use player accounts or a database. Player progress and client-side game actions are not cheat-proof; this setup is suitable for a friends game, not a ranked competitive game.
