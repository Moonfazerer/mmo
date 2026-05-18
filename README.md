# HTML MMO Prototype

A tiny browser MMO-style game:
- Shared real-time world
- Multiplayer movement (WASD or arrow keys)
- Global chat
- Player names
- Rock mining (`E` near a rock)
- Persistent rock inventory (saved per browser profile)
- One infinite rock at bottom-right of the map

## Run

1. Install Node.js 18+.
2. In this folder, install dependencies:
   ```bash
   npm install
   ```
3. Start the server:
   ```bash
   npm start
   ```
4. Open:
   - `http://localhost:3000`

Open the same URL in multiple tabs/windows (or different devices on the same network) to test multiplayer.

## Controls

- Move: `WASD` or arrow keys
- Mine: `E` when close to a rock
- Chat: Enter message in chat box

## If It Stays on "Connecting..."

- Do not open `public/index.html` directly with `file://`.
- Do not run it from another dev server port (like `5500`) unless you pass a WS URL.
- Start this project's server with `npm start` and use `http://localhost:3000`.
- Optional override: `http://localhost:3000/?ws=ws://localhost:3000`

## Project Files

- `server.js` - Express + WebSocket server, player simulation, mining logic, inventory persistence
- `public/index.html` - UI shell
- `public/styles.css` - HUD/chat/dialog styles
- `public/main.js` - networking, input, rendering loop, rock mining client logic
- `inventories.json` - created automatically after mining; stores persistent inventory counts
