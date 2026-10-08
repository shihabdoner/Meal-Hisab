# খাদ্য তথ্য – Meal & Fund Tracker

Static web app (GitHub Pages) with realtime storage in Firebase Firestore.
Everyone who opens the site sees deposits, spending and meal entries update live.

## 1. Create the database (free, ~5 min)
1. Go to https://console.firebase.google.com → **Add project**.
2. **Build → Firestore Database → Create database** (start in production mode, pick a nearby region).
3. **Rules** tab → paste the contents of `firestore.rules` → **Publish**.
4. **Project settings (⚙) → Your apps → Web (`</>`)** → register an app → copy the `firebaseConfig` values.
5. Paste them into `firebase-config.js`.

## 2. Put it on GitHub Pages
1. Create a GitHub repo and upload all files in this folder (keep them at the repo root).
2. Repo → **Settings → Pages** → Source: *Deploy from a branch* → `main` / `/ (root)` → Save.
3. Open `https://<your-username>.github.io/<repo-name>/`.
4. In Firebase: **Authentication → Settings → Authorized domains** → add `<your-username>.github.io` (only needed if you later add sign-in).

## Data layout
- `deposits/{id}`: person, amount, date
- `spending/{id}`: amount, date, details
- `meals/{Person_YYYY-MM-DD}`: lunch, dinner

## Security note
The sample rules let anyone with the link read and write. The Firebase config is public by design,
so for anything beyond a trusted group, add Firebase Authentication and change the rule to
`allow read, write: if request.auth != null;`.

## Run locally
`python3 -m http.server` in this folder, then open http://localhost:8000
