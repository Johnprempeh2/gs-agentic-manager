# GSAM for iPhone

A native SwiftUI app that shows what needs John's approval and what work is
blocked, across every GSAM company his login can see, and answers three Siri commands.

## How it reaches GSAM

The phone talks to the same server as the browser, over Tailscale. John types
the server's `https://` address once on the sign-in screen.

## How it signs in

The app uses the sign-in challenge the `gsam` CLI uses (no server change):

1. `POST /api/cli-auth/challenges` returns an approval page and a pending token.
2. The app opens the page in Safari inside the app. John signs in with his
   GSAM login and taps Approve.
3. The app polls `GET /api/cli-auth/challenges/:id?token=…` until approved,
   then saves the token in the **Keychain only**
   (`AfterFirstUnlockThisDeviceOnly`: never synced, never copied to a new phone).
4. The token lasts 30 days. Sign out calls `POST /api/cli-auth/revoke-current`
   and deletes it from the Keychain.

## What it reads

| Screen    | Route                                                  |
| --------- | ------------------------------------------------------ |
| Account   | `GET /api/cli-auth/me`, `GET /api/companies?scope=accessible` |
| Needs you | `GET /api/companies/:id/attention?sort=decide`         |
| Blocked   | `GET /api/companies/:id/blocked-work`                  |

## Siri

Three App Shortcuts, ready as soon as the app is installed (no setup in the
Shortcuts app). Apple needs the app name in every phrase.

| Say                                  | Siri does                                             | Routes |
| ------------------------------------ | ----------------------------------------------------- | ------ |
| "GSAM status"                        | Says how many items need you, how many tasks are blocked, and the longest wait | `attention?sort=decide`, `blocked-work` for each company |
| "What needs my approval in GSAM"     | Reads the top three items of the attention feed, most severe first | `attention?sort=decide` for each company |
| "Add a GSAM task"                    | Asks for the title and the company, then creates the task | `POST /api/companies/:id/issues` with `{ "title" }` |

The intents run in the background with the same Keychain token and server
address as the app. With no saved sign-in, Siri says "Open GSAM and sign in
first." The logic is in `GSAM/Siri/SiriCommands.swift` and is tested with a
fake server in `GSAMTests/SiriIntentTests.swift`.

## Build and test

You need a Mac with Xcode 16 or later. CI runs the same on a GitHub macOS
runner (`.github/workflows/ios.yml`).

```sh
cd ios
xcodebuild test -project GSAM.xcodeproj -scheme GSAM \
  -destination 'platform=iOS Simulator,name=iPhone 16'
```

The Xcode project uses folder-synced groups: add a Swift file under `GSAM/` or
`GSAMTests/` and it is part of the build, with no project file edit.

## Demo mode (screenshots)

Debug builds take `-GSAMDemo <screen>` (`signIn`, `needsYou`, `blocked`,
`empty`, `error`) and show sample data with no server. CI uses it for the light
and dark screenshots it uploads as the `ios-screenshots` artifact.

## Rules

- Apple frameworks only. No third-party package without Harbor's licence check.
- No tokens, keys, certificates or provisioning profiles in git. Signing and
  TestFlight come from GitHub secrets once John holds the Apple Developer account.
