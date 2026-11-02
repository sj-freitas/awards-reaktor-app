# awards-reaktor-app

Live voting for an awards ceremony. An admin loads the categories, shares a QR code, and runs each category's vote. Attendees vote from their phones and never see counts or winners.

## Stages

Each category moves through these stages, controlled by the admin:

| Stage | Attendee sees |
| --- | --- |
| `lobby` | A "starts soon" message, until the admin shows the first category |
| `waiting` | Category name, plus nominees as the admin reveals them one by one. Voting opens once all are revealed. |
| `voting` | Nominees, can vote or change their vote |
| `closed` | Voting closed message, nominees hidden |
| `winner` | Same as `closed`. The big display shows the winner. |
| `finished` | Thank-you message (after the last category) |

## Screens

- `/admin`: runs the session. Admin sign-in only.
- `/display/<session id>`: the big display slideshow, with nominees and the winner. Admin sign-in only, because attendees know the session code.
- `/qr/<code>`: only the QR code. Public.
- `/s/<code>`: the attendee voting page. Needs a Google account on the session's list.

## Ballot JSON

```json
{
  "allowedEmails": ["ada@reaktor.com", "grace@reaktor.com"],
  "categories": [
    {
      "name": "Best Colleague",
      "nominees": [
        { "name": "Ada", "pictureUrl": "https://example.com/ada.jpg" },
        "Grace"
      ]
    },
    { "name": "Best Idea", "nominees": [] }
  ]
}
```

`allowedEmails` is required and lists who can vote in that session. `pictureUrl` is optional and must be https. A category can have at most 6 nominees.

## Development

```bash
cp .env.example .env
npm install
npm test
npm run dev
```

Tests run against an in-memory Postgres (PGlite), so they need no database. Run the SQL in `supabase/migrations` against a new database before starting the app.

Sign-in needs a Google OAuth web client with `<APP_URL>/auth/google/callback` as an authorized redirect URI. Only addresses in `ADMIN_EMAILS` get admin access.

Attendees get one vote per category per Google account, and can change it until voting stops. Votes are stored under a keyed hash of the email rather than the email itself.
