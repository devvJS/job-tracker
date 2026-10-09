# Job Tracker: guide for AI agents

This is how an agent (for example Dakota's "Job Search" Claude project) reads and logs job
applications in the tracker. The API is the only way in: never write to the database directly.

## Connect

- **Base URL:** `https://devvjs.dev/job-tracker/api`. Every path below is relative to it.
- **Auth:** send `Authorization: Bearer $TRACKER_AGENT_KEY` on every request. The key is in the
  `TRACKER_AGENT_KEY` environment variable. Never print it, log it or put it in a URL.
- **Contract:** read `openapi.yaml` (`GET /openapi.yaml`, same auth) for every route, field,
  enum and error. This file is the short version.
- **JSON:** send bodies with `Content-Type: application/json` (otherwise 415).
- **Rate limit:** about 60 requests per minute per key (fixed one-minute window). Over it you
  get `429` with a `Retry-After` header in seconds. Wait that long, then retry. Don't loop.
- Your writes are recorded as `claude-project` (in `updated_by` and each event's `by`).

```sh
curl -s "https://devvjs.dev/job-tracker/api/applications?q=ford" \
  -H "Authorization: Bearer $TRACKER_AGENT_KEY"
```

## Rules

1. **Check before creating.** Always `GET /applications?q=<company>` before you create
   (`q` matches part of the company or role title, case-insensitively; URL-encode it). Look for the
   same role or `posting_url` in the results. If it's there, update it instead of creating.
2. **Create** with `POST /applications`. Required: `company`, `role_title` (exactly as posted),
   `work_arrangement`, `status`. The server makes the id
   `<company-slug>--<role-slug>--<discovered_at>` (`discovered_at` defaults to today). You can't
   choose it.
3. **A 409 on create means the record already exists** (same id, or the same `posting_url`). That
   is not a failure: the response's `record` field is the existing record. Use it (its `id` and
   `updated_at`) and carry on; do not retry the create.
4. **Prefer events for updates.** To log progress (applied, an email, a call, an interview,
   a status change, a new next action), prefer `POST /applications/{id}/events` over PATCH. It
   never conflicts:
   ```json
   { "type": "call", "note": "Recruiter screen booked", "status": "screen",
     "next_action": "Prepare for recruiter screen", "next_action_due": "2026-10-13" }
   ```
   Only `type` is required. The body takes only `type`, `note`, `at`, `status`, `next_action` and
   `next_action_due`; other keys are ignored and not stored. `status` (when it differs) moves the
   record and logs a `status-change` event for you. Never post `type: "status-change"` yourself (400).
   Event types: `discovered`, `scored`, `materials-drafted`, `applied`, `email`, `call`,
   `interview`, `take-home`, `offer`, `rejected`, `withdrew`, `note`.
   It answers `201` with `{ event, record }`: `event` is the event you added and `record` is the
   full updated application (not the bare record, as the other writes return). Every event
   changes the record's `updated_at`, so your next PATCH needs `If-Match: <record.updated_at>`.
5. **Include `project_thread_url`** (the link to the Claude project thread you are working in)
   when you create or update a record from a thread, so Dakota can find the conversation.
6. **There is no hard delete for you.** The agent key cannot delete records (`DELETE` answers 403).
   To take a record out of the pipeline, move it to `closed` (with a `closed_reason`), `withdrawn`
   or `rejected`. Set `closed_reason` with `PATCH /applications/{id}` (with `If-Match`), not in an
   event body: an event ignores `closed_reason` and drops it silently. For example, PATCH
   `{"status": "closed", "closed_reason": "posting-removed"}` in one request, or post the event
   first and then PATCH `closed_reason` using the `record.updated_at` it returned.
7. **Never invent postings.** Set `posting_status` to what you actually checked (`live`,
   `removed`, `unverified`), and `posting_verified_at` to the day you saw it live.

## Editing fields with PATCH

`PATCH /applications/{id}` changes only the fields you send (`null` clears an optional field).
It needs an `If-Match` header holding the record's `updated_at` exactly as the API last returned it:

```sh
curl -s -X PATCH "https://devvjs.dev/job-tracker/api/applications/<id>" \
  -H "Authorization: Bearer $TRACKER_AGENT_KEY" -H "Content-Type: application/json" \
  -H "If-Match: 2026-10-07T14:00:00.000Z" \
  -d '{"comp_min": 160000, "comp_max": 190000, "comp_source": "recruiter"}'
```

- **428**: you left out `If-Match`. GET the record and send its `updated_at`.
- **412**: the record changed since you read it. The response's `record` is the current
  version. Re-apply your change on top of it and retry once with its `updated_at`.
- **409**: the `posting_url` you sent already belongs to another record (`record` is that one).

Every write changes `updated_at`, so take the next `If-Match` from the write's response:

- `POST /applications` and `PATCH /applications/{id}` return the record itself: use its `updated_at`.
- `POST /applications/{id}/events` returns `{ event, record }`: use `record.updated_at`
  (the event has no `updated_at`).

Contacts work the same way (`GET/POST /contacts`, `PATCH /contacts/{id}` with `If-Match`; both
return the contact itself).

## Values and formats

- **Status**, in pipeline order: `watching` → `shortlisted` → `preparing` → `applied` →
  `screen` → `interviewing` → `offer` → `accepted`. Terminal at any point: `rejected`,
  `withdrawn`, `closed`. Moving to `applied` fills `applied_at` with today if it is empty. Moving
  to a terminal status fills `closed_at` the same way.
- **Dates** are `YYYY-MM-DD` (real calendar dates). **Datetimes** are ISO 8601 with an offset,
  for example `2026-10-07T10:00:00-04:00`, and the year must be from 1000 to 9999. Anything else
  (no offset, a year like `0999`) is 400 `bad_request` naming the field, such as an event's `at`
  or the `updated_since` filter. The API returns datetimes in UTC, like `2026-10-07T14:00:00.000Z`.
- **Enums** are exact strings, listed in `openapi.yaml`. Comp is integer USD per year, base.
  Fit scores (`fit.total` and so on) are integers 0–100.
- `meets_floor` is computed by the server from comp against the $150K floor. Don't send it.
- **Unknown fields** you send are kept (in `extra`) and returned as top-level fields. You can add
  a field before the app knows about it.

## Useful reads

- `GET /applications/{id}`: one record with its `events` and `contacts`.
- `GET /applications?status=applied,screen&min_fit=80&detroit_metro=true`: filters (see
  `openapi.yaml`). List items leave out events and contacts.
- `GET /due` (or `?date=YYYY-MM-DD`): what is due or overdue, for "what's due?".
- `GET /summary?from=YYYY-MM-DD&to=YYYY-MM-DD`: the weekly summary (applied, responses,
  interviews, and conversion by source).

Errors always look like `{ "error": { "code", "message", "details"? } }`. A 400's `details` list
`{ path, message }` for each bad field: fix those fields and resend.
