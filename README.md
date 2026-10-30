# awards-reaktor-app

Live voting for an awards ceremony. An admin loads the categories, shares a QR code, and runs each category's vote. Attendees vote from their phones and never see counts or winners.

## Stages

Each category moves through these stages, controlled by the admin:

| Stage | Attendee sees |
| --- | --- |
| `waiting` | Category name, nominees hidden |
| `voting` | Nominees, can vote or change their vote |
| `closed` | Voting closed message, nominees hidden |
| `finished` | Thank-you message (after the last category) |

## Ballot JSON

```json
{
  "categories": [
    { "name": "Best Colleague", "nominees": ["Ada", "Grace"] },
    { "name": "Best Idea", "nominees": [] }
  ]
}
```

## Development

```bash
cp .env.example .env
npm install
npm test
npm run dev
```

Tests run against an in-memory Postgres (PGlite), so they need no database. Run the SQL in `supabase/migrations` against a new database before starting the app.

Admin sign-in needs a Google OAuth web client with `<APP_URL>/auth/google/callback` as an authorized redirect URI. Only addresses in `ADMIN_EMAILS` can sign in.

Attendees are identified by a browser cookie, which keeps honest voters to one vote per category but won't stop someone using a private window or a second device.
