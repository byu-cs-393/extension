# Architecture overview — CS 393 extension

Visual companion to the [2026-05-11 meeting notes](notes-5-11-2026.md). Diagrams below render natively on GitHub and in VS Code (with the Markdown Preview Mermaid Support extension).

---

## 1. System at a glance

Where each piece lives and who talks to whom.

```mermaid
flowchart LR
    subgraph Browser["🧑‍🎓 Student's Chrome"]
        EXT["Chrome Extension<br/>(content script + popup)"]
        SYNC[("chrome.storage<br/>local + sync")]
        LC["leetcode.com<br/>(content script reads page)"]
        EXT <--> SYNC
        EXT -.reads.-> LC
    end

    subgraph GCP["☁️ Google Cloud — project cs393-496021"]
        FN["Cloud Functions<br/>(HTTPS endpoints)"]
        FS[("Firestore<br/>NoSQL document DB")]
        SM[("Secret Manager<br/>Canvas API key")]
        FN <--> FS
        FN -.reads.-> SM
    end

    CANVAS["📘 Canvas LMS<br/>(BYU)"]
    TA["👩‍🏫 TA / Instructor<br/>(also runs the extension)"]

    EXT <-->|HTTPS + auth token| FN
    FN -->|REST calls with API key| CANVAS
    TA -.uses.-> EXT
```

**Key idea:** the Canvas API key never lives in the extension. The extension talks to a Cloud Function; the function pulls the key from Secret Manager and makes the Canvas call on the student's behalf.

---

## 2. First-time connection (auth flow)

How a student gets verified the first time they install the extension.

```mermaid
sequenceDiagram
    autonumber
    actor S as Student
    participant E as Chrome Extension
    participant LC as leetcode.com
    participant FN as Cloud Function
    participant FS as Firestore

    S->>E: Install extension, open popup
    E->>LC: Read LeetCode session cookie
    LC-->>E: Cookie (proof of LC identity)
    E->>S: "Enter your BYU netID and student ID"
    S->>E: netID + student ID
    E->>FN: POST /connect { lc_cookie, netID, studentID }
    FN->>LC: Verify cookie (call LC API as user)
    LC-->>FN: LC user info
    FN->>FS: Look up netID in roster
    FS-->>FN: Match? roster entry
    alt netID + studentID match roster
        FN->>FN: Generate connection key
        FN->>FS: Save { netID → LC userId, key, devices }
        FN-->>E: 200 OK + connection key
        E->>E: Store key in chrome.storage.sync<br/>(auto-syncs to other devices)
    else mismatch
        FN-->>E: 401 Unauthorized
    end
```

**Why this works:** chrome.storage.sync (~1 MB) automatically replicates the connection key across every Chrome instance the student is signed into — so they install on laptop + desktop and don't re-auth.

---

## 3. TA signs off a topic exam → Canvas grade posted

The flagship workflow. Highest priority feature from the meeting.

```mermaid
sequenceDiagram
    autonumber
    actor TA as TA
    actor S as Student
    participant E as Student's Extension
    participant FN as Cloud Function
    participant SM as Secret Manager
    participant FS as Firestore
    participant CV as Canvas API

    S->>TA: "Ready to pass off topic 4"
    TA->>E: Click "Sign off" in popup,<br/>enter TA code
    E->>FN: POST /signoff { studentKey, taCode,<br/>topicId, problemId }
    FN->>FS: Validate studentKey + taCode
    FS-->>FN: ✓ both valid
    FN->>FS: Write topicExams/{netID}/{topicId}<br/>= { passed, by: TA, at: now }
    FN->>SM: Get Canvas API key
    SM-->>FN: 🔐 key
    FN->>CV: PUT /courses/.../assignments/.../submissions
    CV-->>FN: 200 OK
    FN-->>E: ✅ "Signed off & posted to Canvas"
    E->>S: Show confirmation
```

---

## 4. Data model (Firestore collections)

Firestore is document-based — think "folders of JSON files." Each box below is a collection; arrows are references.

```mermaid
erDiagram
    STUDENT ||--o{ ACTIVITY : "logs"
    STUDENT ||--o{ TOPIC_EXAM : "passes"
    STUDENT ||--o{ KEYSTROKE_RECORDING : "produces"
    STUDENT }o--o| MOCK_INTERVIEW : "participates"
    TA ||--o{ TOPIC_EXAM : "signs off"
    CLASS ||--|{ STUDENT : "enrolls"
    CLASS ||--o{ COMPETITION : "weekly"

    STUDENT {
        string netID PK
        string studentID
        string leetcodeUserId
        string connectionKey
        array  devices
        string privacyOptIns
    }

    ACTIVITY {
        string netID FK
        string problemSlug
        timestamp at
        string event "view_open_submit_pass"
        int    durationMs
    }

    TOPIC_EXAM {
        string netID FK
        string topicId
        timestamp passedAt
        string signedOffBy "TA netID"
        string kind "performance_or_articulation"
    }

    KEYSTROKE_RECORDING {
        string netID FK
        string problemSlug
        array  keystrokes "ts plus key"
        bool   pastedFlag
    }

    MOCK_INTERVIEW {
        string sessionID PK
        array  participants
        timestamp at
    }

    COMPETITION {
        string weekISO PK
        map    scores "netID -> points"
    }

    TA {
        string netID PK
        string codeHash
        bool   active
    }
```

**Privacy rule from the meeting:** anything stored about a student must be visible/replayable to that student. The `KEYSTROKE_RECORDING` collection in particular is what enables the "play back how you typed your solution" feature.

---

## 5. Feature priorities (build order)

What to ship first vs. later. From the meeting's priority discussion.

```mermaid
flowchart TB
    classDef p1 fill:#16a34a,color:#fff,stroke:#15803d
    classDef p2 fill:#3b82f6,color:#fff,stroke:#2563eb
    classDef p3 fill:#a855f7,color:#fff,stroke:#9333ea
    classDef p4 fill:#9ca3af,color:#fff,stroke:#6b7280

    A["1. TA signoff +<br/>Canvas grade reporting"]:::p1
    B["2. Activity tracking +<br/>falling-behind alerts"]:::p2
    C["3. Copy-paste detection +<br/>keystroke playback"]:::p2
    D["4. 'Students on this problem now'<br/>→ Teams chat collab"]:::p3
    E["5. Anonymous head-to-head<br/>+ percentile motivation"]:::p3
    F["6. Stretch: own LeetCode-replacement site<br/>(students contribute problems)"]:::p4

    A --> B --> C --> D --> E --> F
```

Green = MVP. Blue = next. Purple = motivation/social layer. Grey = stretch goal for a future semester.

---

## 6. Deployment pipeline

How code gets from Jack's machine to a real installed extension.

```mermaid
flowchart LR
    DEV["💻 Jack's laptop<br/>code + manifest.json"]
    GH["🐙 GitHub repo<br/>byu-cs-393/extension"]
    GA["⚙️ GitHub Actions<br/>(on manifest version bump)"]
    CWS["🟦 Chrome Web Store<br/>(instructor's dev license)"]
    REV["👁️ Google review"]
    USR["🌐 Students' Chrome<br/>(auto-update)"]

    DEV -->|git push| GH
    GH -->|trigger| GA
    GA -->|upload zip| CWS
    CWS --> REV
    REV -->|approved| USR
```

For local development: load the unpacked extension folder directly into Chrome via `chrome://extensions` → "Load unpacked." No build step needed initially.

---

## Glossary (quick reference)

| Term | What it is |
|---|---|
| **Chrome extension** | A folder with a `manifest.json` + JS/HTML/CSS. Runs in the user's Chrome. |
| **Content script** | Extension JS injected into a real webpage (e.g., leetcode.com) so it can read/modify the DOM. |
| **chrome.storage.sync** | ~1 MB key-value store that auto-replicates across the user's Chrome installs. |
| **chrome.storage.local** | ~20 MB key-value store, single device. |
| **Firestore** | Google's hosted NoSQL document DB. Stores JSON-shaped documents in collections. |
| **Cloud Function** | A small piece of code that runs on demand when an HTTPS endpoint is hit. Like AWS Lambda. No always-on server. |
| **Secret Manager** | A safe place to store API keys/credentials. Cloud Functions can read them; the extension never sees them. |
| **ADC (Application Default Credentials)** | How `gcloud`-authenticated tools authenticate to Google APIs from a dev machine. |
