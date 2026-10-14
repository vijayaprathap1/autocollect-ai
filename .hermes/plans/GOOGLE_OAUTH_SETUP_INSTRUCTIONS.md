# How to Create Google OAuth Credentials for Gmail Login

Follow these steps to create Google OAuth credentials for the Autocollect-AI application:

## Step 1: Go to Google Cloud Console
1. Visit https://console.cloud.google.com/
2. Sign in with your Google account (preferably a Gmail account for testing)
3. Create a new project or select an existing one

## Step 2: Enable Required APIs
1. In the left sidebar, go to "APIs & Services" > "Library"
2. Search for and enable:
   - Google+ API (for older APIs) or
   - Google People API (for newer user info)
   - Google OAuth2 API

## Step 3: Configure OAuth Consent Screen
1. Go to "APIs & Services" > "OAuth consent screen"
2. Select "External" as User Type (for testing with any Google account)
3. Click "Create"
4. Fill in the application details:
   - Application name: "AutoCollect AI"
   - User support email: Your email
   - Developer contact information: Your email
5. Under "Authorized domains", add:
   - For development: `localhost`
   - For production: Your actual domain (e.g., `autocollect.ai`)
6. Click "Save and Continue" through the scopes, optional info, and summary screens
7. Click "Back to Dashboard"

## Step 4: Create OAuth Client ID
1. Go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "OAuth client ID"
3. Select "Web application" as Application type
4. Enter a name: "AutoCollect AI Web"
5. Under "Authorized redirect URIs", ADD:
   - `http://localhost:4000/auth/google/callback` (for development)
   - `https://yourdomain.com/auth/google/callback` (for production - replace with actual domain)
6. Click "Create"

## Step 5: Copy Credentials
1. After creation, you'll see a dialog with your Client ID and Client Secret
2. Copy both values:
   - Client ID: Looks like `1234567890-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com`
   - Client Secret: A long alphanumeric string

## Step 6: Add to Environment Variables
Add these to your `apps/api/.env` file:
```
GOOGLE_CLIENT_ID=your_client_id_here
GOOGLE_CLIENT_SECRET=your_client_secret_here
```

## Important Notes:
- Keep these credentials secret - never commit them to version control
- The redirect URIs must match exactly what you configure in Google Cloud
- For development, you can use `http://localhost:4000/auth/google/callback`
- Make sure to enable the Google People API or similar for user info endpoint
- Test the flow thoroughly in development before deploying to production

Once you have these credentials, I'll proceed with implementing the Google OAuth integration in the codebase.