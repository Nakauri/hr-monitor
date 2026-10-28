# Web recorder (design; built in Block 3 as `recorder.js`)

Scope: how the web monitor (desktop Web Bluetooth) saves a session to the user's folder and to Drive. Out of
scope: the phone's native recorder. The page creates no recorder when NATIVE or when
`HRMNativeHrSession.isAvailable` (the native plugin owns Drive). Status: v8, ACCEPTED for Block 3 after 7 skeptic rounds (round 7: no MUST, its 4 SHOULD folded in) (v5 drops v4's abort-and-rewrite: the final never overlaps a routine write).

## Why
About fifteen module globals guarded by a session counter held the save. Six review rounds each found another
way an old save reached the next session or Stop reported a wrong result; design rounds 1 and 2 found more in
today's code (a routine save landing after the final; a new Start with permission denied writing into the old
file; the folder retry; Export hidden after a failed folder). Here the session is an object with one owner.

## API
`AortiRecorder.create(env)` returns one recorder per page. It holds the current Recording; recorder.js has no
other module-level state.
- `start(id, startMs, dir)`: stops any Recording not `done` (its `final` keeps running), then creates a new one
  for page session `id` with the folder `dir` (or null); `filename` comes from `startMs`. Returns it. A folder
  picked or cleared with no Recording, or while the current one is stopping, is simply passed at the next start.
- `stop()`: the current Recording (the same one on every call; its `final` settles when both targets have a result); null if none.
- `hidden()`, `closing()`: page lifecycle (rules 12, 18). `entered()`: the page committed a mark or note (rule 21).
- `folderChanged(dirOrNull)`, `authChanged()`: targets changed (rule 15, rule 8).
- `targets()`: `{ folder, drive }` booleans for the current Recording (the unsaved notice reads this).
- `current()`: the current Recording or null (status filtering, the page's tests).

## Session id and the final text (the order that keeps data apart)
- The page's session id is a counter bumped in the same synchronous step as `resetLiveDataBuffers` and
  `setSessionStart`, and only after `recorder.stop()` was called. The new id reaches `recorder.start(id)` later.
- `env.buildCsv(id)` returns null when the page's id is not `id`, so an old Recording can never build new data.
- `stop()` builds the final text synchronously, before its first await. Every later step uses that text, so a
  page reset after the 30 s cap cannot empty it. A null final text makes every seen target `unwritten`;
  unseen ones stay `null` (rule 14).

## The Recording
| field | meaning |
|---|---|
| `id`, `filename` | the page session; `hrv_session_<UTC start to the second, colons as dashes>.csv` (today's web format; the viewer reads a `.123` suffix as a native local-time name), used by folder, Drive and Export; if it equals the previous Recording's, the next second is used |
| `text` | the final text built at `stop()`, or null; never rebuilt. Every Export after Stop downloads it as `filename` |
| `dir`, `file` | the folder chosen and this session's file handle |
| `driveFileId`, `login` | this session's Drive file and the sign-in tag it belongs to |
| `rows`, `bytes`, `builtAt`, `driveAt`, `forcedAt` | pacing inputs; `bytes` of the encoded text |
| `folderBusy`, `upload` | the one folder write and one Drive upload in flight |
| `strikes` | consecutive folder write failures |
| `state` | `arming`, `live`, `stopping`, `done` |
| `seen`, `folderName` | a target was present at some point in the session; the folder's name, kept |
| `wrote` | `{ folder, drive }`: at least one write landed on that target this session |
| `result` | per target, set at `stop()`: `null` if never `seen`, else `pending` until its final write settles, then `saved`, `failed` (wrote before, final did not land) or `unwritten` (never landed). A target first seen while `stopping` is not uploaded and stays `null`. |

## States and events
| event | arming | live | stopping | done |
|---|---|---|---|---|
| tick (10 s) | Drive routine save only | folder and Drive, paced | refused | refused |
| hidden | nothing | rule 12 | nothing | nothing |
| closing | nothing | rule 12, best effort | nothing | nothing |
| folder pick or clear | taken at the end of arming | rule 15 | ignored | ignored |
| sign in, out, switch | rule 8 | rule 8 | rule 8 on the final upload | ignored |
| permission or creation fails | to `live`; file null; status `denied` or `error` | file null, status `error` (rule 15 pick) | | |
| stop() | to `stopping`: no file, final to Drive | to `stopping` | same `final` | same `final` |
| final settles | | | to `done` | |

## Rules (each a mutant in recorder.mutants.cjs unless marked PAGE)
1. A Recording writes only through its own `file` and `driveFileId`; env has no "current file" getter.
2. `start()` stops the previous Recording first; two Recordings never both tick.
3. Routine saves run only while `live` (Drive also while `arming`), re-checked after every await.
4. One folder write and one upload at a time per Recording, never overlapping: a routine save skips when one
   is in flight, and the final waits for an in-flight routine write or upload on that target to settle, however
   long, before its own. Nothing is aborted (a folder `close()` cannot be, and Drive may commit an aborted
   PATCH). A slow wait is reported, not cut short: results stay `pending` and the panel and Export follow
   (rule 17). Drive: if any routine PATCH on this file ended with no HTTP status (a dropped connection may still
   commit), the final, after its own PATCH succeeds, waits `settleMs` (injectable, 5 s), reads
   `files/<id>?fields=size`, and PATCHes once more if the size is not the final's bytes, then reads once more.
   `saved` only on a matching read. A read with no status, a 5xx, a 401 after one refresh, a 403 or 404, or a
   sign-out during `settleMs` makes `result.drive` `failed`. The newest pick's pending `createFile` is waited
   for like a write.
5. The final save: the folder final and the Drive final run independently, each waiting only on its own
   target (rule 4); a hung folder never holds up Drive. Drive needs sign-in with sync on; `env.ensureFolder()`
   runs first only when `folderId()` is null, and a failed lookup with a known `folderId()` does not block the
   upload. `final` settles when both targets have a result; the panel's 30 s cap only changes its wording.
6. Drive folder: at Start, and at most once a minute on a tick while signed in with sync on and `folderId()`
   null, call `env.ensureFolder()`.
7. Stop during `arming` ends it: no interval; the handle a pending `createFile` returns is dropped and never
   written (an empty file may remain); `result.folder` is `unwritten` when a folder was chosen.
8. Login: token, folder id and login tag are read together after the last await before each fetch. A change
   from the Recording's `login` clears `driveFileId` and takes the new login; a null tag (signed out) is never a
   change. A create whose login changed in flight is discarded; for the final, it then creates once under the
   new login and `result.drive` follows that create. A PATCH answered 403 or 404 clears `driveFileId`
   once and creates. Limit: a login without an email gets a random tag, so a switch is seen only on sign-out.
9. A 401 refreshes once and retries once. A routine 5xx waits for the next pace (`driveAt` is set on the
   attempt); the final retries once.
10. Three folder failures in a row drop `file` with status `write error (3/3)`; Drive continues.
11. Pacing: folder every tick below SAVE_BIG, above it at most one rebuild a minute. Drive pace =
    clamp(file MB x 60 s, 60 s, 10 min). No target: nothing is built.
12. Hidden or closing, only in `live`: a forced folder write if `env.rowCount()` grew since the last build, at
    most once per 10 s below SAVE_BIG (closing skips this when no write is in flight) and once a
    minute above it, shared with the tick's rebuild; Drive only when its pace allows.
13. Status (`writing`, `synced`, `drive error: ...`, `denied`, `error`, `write error (n/3)`) is set only while
    `current()` is the Recording reporting it. After Stop: `saving` while any result is `pending`, then `idle`
    unless a final write failed, then the failure.
14. Results: a target counts if `seen`. `saved` only if the final's own write on it succeeded; otherwise `failed`
    if `wrote`, else `unwritten`. A target seen but gone at Stop (folder cleared, signed out) is never `saved`.
    A null final text makes every seen target `unwritten`. A seen target with no final write to make (no
    `file` and no newest-pick `createFile` pending, signed out or sync off when the final reaches it, including
    during its wait) takes `failed` if
    `wrote`, else `unwritten`, at that moment, so `final` always settles once its writes have.
15. A folder picked mid-session is taken up (same `filename`): a pick clears `file`, and `folderName` and `file`
    change together when `createFile` resolves. Only the newest pick's `createFile` is taken; an older one's
    handle is dropped and never written. A folder cleared drops `file`. A pick or clear ends the old handle's
    claim: its in-flight write no longer holds `folderBusy`, and its outcome never changes `strikes`, `wrote` or
    status. The final waits only on writes to the current `file`.
16. PAGE: every Stop entry point (Stop button, takeover by another device, stopping the local broadcast) flushes
    held marks and an open note, then calls `recorder.stop()`; marks are refused while stopping.
17. PAGE: the after-stop panel shows per target `saved` "Saved to <folderName>" / "Saved to Drive", `failed`
    "Last save to <folderName> failed" / "Drive upload failed", `unwritten` "Not saved to <folderName>" /
    "Not saved to Drive", `pending` "Saving to <folderName>" / "Drive upload incomplete", updated when `final`
    settles. Export (the text built at Stop) and the leave-page guard are on while any result is `pending` or
    none is `saved`, re-checked when `final` settles; Export is hidden when the final text is null.
    Takeover and broadcast stops show the panel when, at 30 s or when `final` settles if sooner, any result is
    `pending`, `failed` or `unwritten`, or none is `saved` (no target seen included).
    The page keeps every Recording it got from `stop()` until its `final` has settled and either a target is
    `saved` or its Export was taken. Each one kept has its own notice line with its result texts and its own
    Export (`rec.text` as `rec.filename`, never `buildSessionCSV()`), and the leave guard stays on while any is kept.
    The panel shows only the newest Recording from `stop()`. A settle or 30 s timer of any other Recording updates
    only its own notice line. A Start hides the panel and cancels its pending 30 s show.
18. PAGE: leaving the tab (hidden) commits held marks, then calls `recorder.hidden()`; Undo ends there. pagehide
    flushes the note and any mark held since, then calls `recorder.closing()`. `addMarker`, the one writer of marks,
    calls `recorder.entered()` for each (rule 21).
19. PAGE: `connectWeb` calls `recorder.stop()` immediately before the session id bump, so no path reaches a new
    id with a Recording still live (today every path to idle runs `disconnect()`; this makes it a rule).
20. PAGE: the Start click asks `dir.requestPermission` before `connect` (Chrome denies it after the strap
    picker's async work); in `arming`, `env.ensurePermission` only queries.
21. A forced save is urgent when an entry was committed (`entered()`) since the text last sent to the folder was
    built, however long ago; it skips the pacing (rules 11, 12). If a folder write is in flight, the Recording is
    owed one write: when that write settles, or a newly picked file is made, text built then goes to the file that
    is current then, only while `live` and never beside another write (rule 4). A dropped handle (strike 3, a pick or
    a clear) never gets it; after Stop the final carries everything.

## Scenarios (recorder.test.cjs; PAGE ones in a page check)
| # | scenario | expected |
|---|---|---|
| S1 | Stop with a routine upload in flight | final waits, then uploads; result.drive saved |
| S2 | Routine save slow in its folder write at Stop | folder and Drive both end with the final text |
| S2b | Routine write still running long after Stop, then succeeds | final waits for it, then writes; result pending until then, then saved; the file ends with the final text |
| S3 | Note open at Stop (PAGE) | the note is in the final file |
| S4 | Stop (takeover) during `arming` while `createFile` is pending | nothing written to the file, no interval; Drive gets the data; result.folder unwritten |
| S5 | Start while the old final is uploading | old upload lands in the old file only |
| S6 | Old Recording live, then Start | old one stopped first; its file never gets new data |
| S7 | Page reset after the 30 s cap | the final still writes the text built at Stop |
| S8 | Folder write past 30 s (PAGE) | "Saving to", then Saved or failed |
| S9 | Mark during Saving (PAGE) | refused with the ended toast |
| S10 | Folder lookup failed at load | routine uploads reach Drive within a minute of the retry |
| S11 | Folder unplugged, no Drive (PAGE) | three strikes; panel "Last save to <folder> failed" and Export offered |
| S12 | Account switch during the first create, and during an old final | old ids discarded; uploads go to the new account |
| S13 | Same account signs out and back in | the same Drive file keeps being updated |
| S14 | PATCH answered 404 | one create, then PATCHes to the new file |
| S15 | New Start with permission denied after an old final past the cap | nothing written into the old file |
| S16 | Sign in mid-session | routine Drive saves start; `targets()` reports Drive |
| S17 | 20 hides a minute at 48 h | at most one forced rebuild a minute; Drive within pace |
| S18 | A hung upload at Stop | panel "Drive upload incomplete" at 30 s; Export and the leave guard stay on; the result follows when it settles |
| S19 | Signed out, no folder | nothing built or saved; unsaved notice and Export as today |
| S20 | 200k points per series (PAGE, `track`) | each series drops its own start; accepted limit, about 55 h |
| S21 | Start while the old final waits past the cap, then it fails (PAGE) | a notice shows the failure; its Export gives the old text; the leave guard is on |
| S22 | A routine PATCH dropped mid-flight, then the final | the final checks the size after `settleMs` and PATCHes again if it differs; saved only on a match |
| S23 | Sign out while the final waits behind a routine upload | result.drive `failed` (or `unwritten`); `final` settles |
| S24 | Takeover stop with Drive failing | the panel appears with "Drive upload failed" and Export |
| S25 | Stop A with a hung upload, Start and Stop B, then A fails (PAGE) | A's notice and Export (A's own text) still there |
| S26 | Takeover stop with no folder and no sign-in (PAGE) | the panel appears with "Not saved" and Export |
| S27 | Folder write hung at Stop with Drive on | Drive's final runs and settles; result.folder stays pending |
| S28 | Two quick folder picks, the first resolving last | the session saves to the second; the first handle is never written |
| S28b | Folder unplugged at two strikes, third write in flight, user picks B; the old write then fails, or hangs | B keeps its handle and gets routine writes; the final writes B; result.folder saved |
| S30 | Stop while the newest pick's createFile is pending | the final waits, then writes the new file; result.folder saved |
| S31 | A hung, Start, takeover stops B with Drive failing, then A saves | B's panel still "Drive upload failed"; A's notice line shows saved |
| S32 | A web session's file name in the viewer | read as a web (UTC) session on its own day, not as a native file |
| S29 | Folder picked while idle, then Start | the new Recording saves to it from the first tick |

## Costs (measured: 55 bytes a row at 1 Hz; build 14 ms at 1 h, 0.15 s at 12 h, 0.7 s at 48 h)
| session | file | Drive today | Drive with rule 11 |
|---|---|---|---|
| first hour | to 0.19 MB | about 36 MB | about 6 MB |
| at 2.65 h | 0.5 MB (SAVE_BIG) | about 180 MB an hour | about 30 MB an hour |
| at 12 h | 2.3 MB | every 2.3 min, about 60 MB an hour | the same |
| 48 h in all | 9.2 MB at the end | about 3.0 GB | about 2.8 GB |
Correction: a code comment said "a few hundred MB" over 48 h; it is about 3 GB. Rule 11 now cuts typical 1 to
3 h sessions about six-fold, with Drive at most 60 s behind early and 10 min late. Block 3b: hourly parts in
the native segment format (`hrm_<date>T<hh>Z_<id>.csv`, which the viewer reads), each closed part uploaded once
and the open part paced, about 12 MB an hour and at most a minute behind; it needs a parity test with native.

## Accepted limits
- A crash while visible loses at most one folder tick and one Drive pace; no event fires.
- Something entered at tab close reaches the folder only if the browser lets the page finish that write (rule 21).
  Drive gets it only when its pace allows; the folder file and Export are the record. Design pass 2026-10-28 (rule
  21), after review rounds 1 to 4 each found a defect on this path.
- Three account switches during one final create save it under the middle account (rule 8).
- Points recorded during the "Saving" wait are not in the file (the final text is built at Stop).
- An ambiguous Drive create can leave a duplicate file (Block 3b: `files.generateIds`).
- A login without an email is seen as switched only on sign-out (rule 8).
- A request that never settles leaves its result `pending` for good; the panel says so, Export and the leave
  guard stay on. Browsers fail a stalled fetch on their own, so this is rare, and it never shows a false Saved.
- A dropped routine PATCH that Drive commits later than `settleMs` after the final can still roll the Drive copy
  back; the folder copy and Export are unaffected. Block 3b's closed parts remove it (each is written once).

## env (recorder.js runs with no page)
- Timing: `now`, `setInterval`, `clearInterval`, `setTimeout`, `clearTimeout`; injectable limits (tick,
  SAVE_BIG, strikes, pace).
- Data: `buildCsv(id)`, `rowCount()`.
- Folder: `ensurePermission(dir)`, `createFile(dir, name)`, `writeFile(handle, text)` (resolves when `close()` does).
- Drive: `token()`, `folderId()`, `ensureFolder()`, `syncOn()`, `loginTag()`, `fetch`, `authHeader()`, `refresh()`.
- Page hooks: `onStatus(text, cls)`, `warn`.
- Not in env: `document`, `window`, `NATIVE`.
