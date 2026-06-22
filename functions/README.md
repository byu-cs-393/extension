# CS 393 Buddy — Cloud Functions

Server-side functions for the extension. Currently just `verifyStudent` — Canvas-backed identity verification for onboarding. See [index.js](index.js) for the function code itself.

## One-time setup

Run these from the **repo root** (not from `functions/`):

```bash
# 1. Install function dependencies
cd functions && npm install && cd ..

# 2. Provide the Canvas API token used for server-side lookups.
#    For testing, you can use your own Canvas access token (only your
#    own netID will verify). For real use, this should be an
#    instructor-level token that can view student profiles in CS 393.
#    Generate at: BYU Canvas → Account → Settings → "+ New Access Token"
firebase functions:secrets:set CANVAS_API_TOKEN
# (paste the token at the prompt)

# 3. Deploy
firebase deploy --only functions
```

After deployment, Firebase prints the function's URL. The callable function lives at:

```
https://us-central1-cs393-496021.cloudfunctions.net/verifyStudent
```

## Testing the function end-to-end

You can call the deployed function directly with `curl` to sanity-check before wiring it into the extension.

First, grab your own `lti_user_id` — open https://byu.instructure.com in a browser, then in DevTools console run:

```js
const r = await fetch("/api/v1/users/self/profile", { credentials: "include", headers: { Accept: "application/json" } });
(await r.json()).lti_user_id
// → "89cdefa52cc6371eb958ffdf29d36b17db015d55" (or similar 40-char hex)
```

Then call the function:

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"data":{"netID":"<your-netid>","ltiUserId":"<your-lti-user-id>"}}' \
  https://us-central1-cs393-496021.cloudfunctions.net/verifyStudent
```

Expected response on success:

```json
{ "result": { "token": "eyJ...<long Firebase custom token>" } }
```

Expected failures (and what they mean):

- `invalid-argument` → bad input format (regex didn't match)
- `not-found` → Canvas couldn't find that netID (typo? not enrolled?)
- `permission-denied` → the `ltiUserId` you sent doesn't match what Canvas returns for that netID (you're claiming to be someone you aren't — or the token doesn't have permission to view profiles)
- `internal` → Canvas API request failed for some other reason; check function logs with `firebase functions:log`

## Updating the secret later

```bash
firebase functions:secrets:set CANVAS_API_TOKEN
firebase deploy --only functions   # required to pick up the new secret
```

## Deploying Firestore rules alongside

`firebase.json` at the repo root also references `firestore.rules`, so you can deploy both together:

```bash
firebase deploy
# or just the rules:
firebase deploy --only firestore:rules
```
