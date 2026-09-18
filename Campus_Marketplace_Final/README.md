# Campus Marketplace — Final Working Build

## Requirements
- Node.js 18 or newer
- VS Code recommended

## Run
1. Extract this folder.
2. Open the folder in VS Code.
3. Open Terminal in the project folder.
4. Run:
   `node server.js`
5. Open:
   `http://localhost:3000`

On Windows you can also double-click `start.bat`.

## Demo account
Email: `student@campus.local`
Password: `student123`

You can also create a new account from the Login screen.

## Main working modules
- Registration and login
- Persistent server-side user data
- Marketplace product listing
- Search and category filtering
- Product details
- Contact seller
- Persistent product-specific chat
- Student verification with college-ID file storage
- Verified seller status
- Persistent JSON database in `data/db.json`

## Project structure
- `public/index.html` — UI
- `public/style.css` — existing Liquid Glass UI + functional additions
- `public/script.js` — frontend application logic
- `server.js` — backend/API/server
- `data/db.json` — persistent application data
- `uploads/` — uploaded verification files
- `package.json` — run configuration
- `start.bat` — Windows quick start

## Important
This build is designed to be fully runnable locally for submission and demonstration. It uses a file-backed JSON database so it requires no external database installation or internet connection.
