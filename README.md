# Sudoku Together

Real-time multiplayer Sudoku in the browser. Create a room, share the link, and play with friends.

## Features

- **Two multiplayer modes**
  - **Co-op**: everyone fills in the same board. You can see where teammates are, and a small colored dot shows who placed each number.
  - **Versus**: everyone gets the same puzzle on a private board. Live progress bars show how far along each player is, and players are ranked by finish order.
- **Four difficulties**: Easy, Medium, Hard and Expert. Every puzzle is freshly generated and has exactly one solution.
- **Notes (pencil marks)**: when a number is placed, matching notes in the same row, column and box are removed automatically.
- **Auto notes**: fills in every possible candidate with one click.
- **Hints that explain themselves**: for example, "7 has only one possible spot in this box". There are 3 hints per game.
- **Mistake limit** of 3, 5 or none. In co-op you can choose to keep playing after running out.
- **Undo, erase, timer and pause** (pausing affects the whole room).
- **Highlighting**: selecting a cell highlights its row, column and box plus every copy of the same number. Wrong numbers and the cells they clash with are also marked.
- **Animations** when a row, column or box is completed, and confetti when the puzzle is solved.
- **Chat and emoji reactions**, invite links, light and dark mode, and a layout that works on phones.
- **Automatic reconnect**: refresh the page or lose your connection and you rejoin where you left off.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `1`–`9` | Place number |
| `Shift` + `1`–`9` | Toggle note |
| Arrow keys | Move |
| `Backspace` / `Delete` | Erase |
| `N` | Notes mode on/off |
| `A` | Auto notes |
| `Ctrl` + `Z` | Undo |
| `H` | Hint |
| `P` | Pause / resume |

## Run it locally

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Then open http://localhost:3000. To try multiplayer on one computer, open a second browser window (or an incognito window) and join with the room code.

`npm run dev` restarts the server automatically when you edit a file. `npm test` runs an end-to-end check with two simulated players.

## Project structure

```
server.js           Web server + real-time game rooms (Express + Socket.IO)
server/sudoku.js    Puzzle generator, solver and hint logic
public/index.html   Page layout
public/style.css    Styling (light + dark themes)
public/app.js       Everything that runs in the browser
test/smoke.js       Automated end-to-end test
```

The server is the source of truth. It keeps the solution private, checks every move, and sends each player only what they're allowed to see. Game rooms are kept in memory, so restarting the server clears them. Empty rooms are removed after 30 minutes.

## Deploying

This app needs a host that runs a long-lived Node.js server with WebSockets. [Render](https://render.com) works on its free plan:

1. Push this project to GitHub.
2. On Render, choose **New → Web Service** and connect the repository.
3. Set **Build command** to `npm install` and **Start command** to `npm start`, then pick the **Free** instance type.
4. Deploy, then share the `https://<your-app>.onrender.com` link.

On the free plan the app goes to sleep after about 15 minutes with no visitors. The next visit takes about a minute to wake it up, and any games that were running are lost.
