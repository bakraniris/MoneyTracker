# Setup & Migration Guide

## .env keys needed

Add these to `.env` (or `.cursorignore/.env`):

```
DB_CONNECTION_STRING=postgresql://...your-supabase-connection-string...
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbG...your-anon-key...
```

Where to find them in Supabase Dashboard:

| Key | Location |
|-----|----------|
| `DB_CONNECTION_STRING` | Settings > Database > Connection string > URI |
| `SUPABASE_URL` | Settings > API > Project URL |
| `SUPABASE_ANON_KEY` | Settings > API > anon / public key |

## Start the app

```bash
npm install
npm start
```

## Migrate old SQLite data

1. Start the app and **sign up** with your email
2. Go to Supabase Dashboard > **Authentication** > **Users**
3. Copy your **User UID**
4. Add to `.env`: `MIGRATION_USER_ID=your-uid-here`
5. Run: `npm run migrate`

This assigns all your old data to your account.
