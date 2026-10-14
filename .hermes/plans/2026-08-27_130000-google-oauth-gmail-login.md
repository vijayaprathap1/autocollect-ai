# Google OAuth (Gmail) Login Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add "Sign in with Google" authentication option using Gmail as the OAuth provider for user login in the Autocollect-AI application.

**Architecture:** Extend the existing authentication system (Clerk-based) to include Google as a social login provider. Leverages Clerk's built-in OAuth support for Google, requiring minimal code changes primarily in configuration and UI.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Clerk authentication, Google OAuth 2.0

---

### Task 1: Verify Current Authentication Setup

**Objective:** Confirm the project uses Clerk for authentication and understand its current configuration to ensure Google OAuth integration aligns with existing patterns.

**Files:**
- Read: `apps/api/src/app.ts` (backend auth middleware)
- Read: `apps/api/src/auth.ts` or similar auth configuration
- Read: `.env.example` (to see Clerk variables)
- Search: `search_files("clerk", target="content", path="apps/")`

**Step 1: Examine backend auth configuration**

```bash
# Check if Clerk is initialized in backend
grep -r "Clerk" apps/api/src/ --include="*.ts"
```

**Step 2: Check frontend auth usage**

```bash
# Look for Clerk components in frontend
grep -r "@clerk/" apps/web/ --include="*.tsx"
```

**Step 3: Review environment variables**

```bash
# Check .env.example for Clerk configuration
cat apps/api/.env.example
```

**Expected Output:** Confirmation that Clerk is used with `CLERK_SECRET_KEY` and `CLERK_ISSUER` environment variables.

**Step 4: Commit verification findings**

```bash
git add .hermes/plans/2026-08-27_130000-google-oauth-gmail-login.md
git commit -m "plan: verify current auth setup for Google OAuth"
```

---

### Task 2: Create Google OAuth Credentials

**Objective:** Obtain Google OAuth Client ID and Secret for the application to enable Gmail login.

**Files:** None (external setup in Google Cloud Console)

**Step 1: Create Google Cloud Project**

- Go to https://console.cloud.google.com/
- Create a new project or select existing
- Enable Google+ API (or Google Identity APIs)

**Step 2: Configure OAuth Consent Screen**

- Set User Type to "External" (for testing)
- Fill in app details (name, support email, etc.)
- Under "Authorized domains", add your domain (e.g., localhost for dev, production domain for prod)

**Step 3: Create OAuth Client ID**

- Choose "Web application" as application type
- Add authorized redirect URIs:
  - Development: `http://localhost:3000/api/auth/callback/google` (if using NextAuth) OR Clerk's endpoint
  - Production: `https://yourdomain.com/api/auth/callback/google`
- Note: Exact redirect URI depends on auth implementation (Clerk handles this internally)

**Step 4: Record Credentials**

- Copy the generated Client ID and Client Secret
- These will be added to environment variables

**Step 5: Document credentials for later use**

```bash
# Create a temporary note (not committed)
echo "GOOGLE_OAUTH_CLIENT_ID=your_client_id_here" > .env.google
echo "GOOGLE_OAUTH_CLIENT_SECRET=your_client_secret_here" >> .env.google
```

**Step 6: Commit documentation**

```bash
git add .hermes/plans/2026-08-27_130000-google-oauth-gmail-login.md
git commit -m "plan: documented Google OAuth credential setup steps"
```

---

### Task 3: Configure Google OAuth in Clerk

**Objective:** Enable Google as a social login provider in the Clerk dashboard using the obtained credentials.

**Files:**
- Modify: `.env` (to add Google OAuth credentials for Clerk)
- Modify: Clerk dashboard configuration (external)

**Step 1: Update Environment Variables**

Add to `apps/api/.env` (create if doesn't exist, based on .env.example):

```env
# Google OAuth for Clerk
GOOGLE_OAUTH_CLIENT_ID=[your_google_client_id]
GOOGLE_OAUTH_CLIENT_SECRET=[your_google_client_secret]
```

**Note:** Clerk automatically picks up `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` for Google social login.

**Step 2: Enable Google in Clerk Dashboard**

- Log in to Clerk dashboard: https://dashboard.clerk.com
- Select your Autocollect-AI instance
- Go to "Social Connections" > "Google"
- Toggle Google to enabled
- Clerk should auto-detect the environment variables; if not, manually enter the credentials
- Save changes

**Step 3: Verify Clerk Configuration**

```bash
# Check that Clerk recognizes Google provider
# This would typically be verified by checking Clerk instance settings
```

**Step 4: Commit environment variable changes**

```bash
git add apps/api/.env
git commit -m "feat: add Google OAuth credentials to environment"
```

---

### Task 4: Update Frontend to Show Google Login Button

**Objective:** Modify the authentication UI to display a "Sign in with Google" button alongside existing login methods.

**Files:**
- Modify: `apps/web/src/app/sign-in/page.tsx` (or similar sign-in page)
- Modify: `apps/web/src/app/sign-up/page.tsx` (if separate)
- Modify: `apps/web/src/components/auth/SignInButtons.tsx` (if exists)

**Step 1: Locate Sign-In Page**

```bash
# Find sign-in page in web app
find apps/web/src -name "*sign-in*" -type f
```

**Step 2: Add Google Sign-In Button**

Assuming we're using Clerk's `<SignIn />` component, we need to ensure Google is enabled in Clerk, which should auto-show the button.

However, if customizing the UI:

```tsx
import { GoogleButton } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div>
      {/* Existing Clerk SignIn components */}
      <GoogleButton />
    </div>
  );
}
```

**Step 3: If Using Custom UI**

If the project uses a custom sign-in page (not Clerk's `<SignIn />`), add:

```tsx
import { GoogleButton } from "@clerk/nextjs";

function CustomSignIn() {
  return (
    <div>
      <h1>Sign in to Autocollect-AI</h1>
      {/* Other login methods */}
      <GoogleButton />
      <p>Or use your email and password</p>
      {/* ... */}
    </div>
  );
}
```

**Step 4: Test Button Appearance**

Run dev server and verify Google button appears on sign-in page.

**Step 5: Commit UI changes**

```bash
git add apps/web/src/app/sign-in/page.tsx
git commit -m "feat: add Google Sign-in button to authentication page"
```

---

### Task 5: Test Google OAuth Flow

**Objective:** Verify the complete Google OAuth login flow works in development and handles edge cases.

**Files:**
- Test: Manual verification via browser
- Test: `apps/web/src/app/sign-in/page.tsx` (no code changes, just verification)

**Step 1: Start Development Server**

```bash
npm run dev
```

**Step 2: Test Google Login Flow**

1. Navigate to `http://localhost:5175/sign-in`
2. Click "Sign in with Google" button
3. Should redirect to Google accounts chooser
4. Select a Gmail account
5. Should redirect back to app and sign in successfully
6. Verify user is authenticated (check session, redirect to dashboard)

**Step 3: Test Edge Cases**

- Cancel during Google login flow
- Invalid/revoked Google credentials
- Existing user signing in with Google (should link or create account)
- New user signing up with Google (should create account)

**Step 4: Verify Session and User Data**

Check that:
- User object contains Google profile info (name, email, picture)
- Session is properly set
- Redirects work correctly after login

**Step 5: Commit Test Notes**

```bash
git add .hermes/plans/2026-08-27_130000-google-oauth-gmail-login.md
git commit -m "plan: documented Google OAuth testing procedure"
```

---

### Task 6: Prepare for Production Deployment

**Objective:** Ensure Google OAuth is configured for production environment.

**Files:**
- Modify: Production environment variables (via hosting platform)
- Modify: Clerk dashboard production settings

**Step 1: Update Production Environment**

Add Google OAuth credentials to production environment:
- For Vercel: Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in project settings
- For other platforms: Configure accordingly

**Step 2: Update Authorized Domains in Google Cloud**

In Google Cloud Console:
- Add production domain to Authorized Domains in OAuth consent screen
- Add production redirect URI: `https://yourdomain.com/api/auth/callback/google`

**Step 3: Enable Google in Clerk Production Instance**

Repeat Task 3 steps in Clerk's production environment (if separate from dev).

**Step 4: Test Production Flow**

Deploy to staging/production and verify:
- Google login button appears
- Authentication works with production Google credentials
- Session handling is correct

**Step 5: Commit Production Readiness**

```bash
git add .hermes/plans/2026-08-27_130000-google-oauth-gmail-login.md
git commit -m "plan: documented production deployment steps for Google OAuth"
```

---

## Summary of Files to Change

1. `apps/api/.env` - Add Google OAuth credentials
2. `apps/web/src/app/sign-in/page.tsx` (or equivalent) - Add GoogleButton component
3. External: Google Cloud Console - Create OAuth credentials
4. External: Clerk Dashboard - Enable Google social login

## Validation Criteria

- [ ] "Sign in with Google" button visible on sign-in page
- [ ] Clicking button initiates Google OAuth flow
- [ ] Successful login with Gmail account creates/authenticates user
- [ ] User session contains correct Google profile data
- [ ] Edge cases (cancel, invalid creds) handled gracefully
- [ ] Flow works in both development and production environments
- [ ] No existing authentication methods broken

## Risks and Tradeoffs

**Risks:**
- Google OAuth setup requires manual steps in Google Cloud Console (potential for misconfiguration)
- If using Clerk, dependency on Clerk's Google integration (less control over flow)
- OAuth redirect URIs must match exactly (common source of errors)

**Tradeoffs:**
- Using Clerk's built-in Google OAuth minimizes code but requires Clerk plan that supports social connections
- Alternative approach (custom NextAuth) would give more control but require significant auth system changes
- Chosen approach leverages existing auth infrastructure for faster implementation

## Open Questions

1. Does the project already use Clerk for authentication in production, or is it only in development?
   - *To be answered during Task 1 verification*
2. Are there any existing social login methods (e.g., GitHub) that we should follow as a pattern?
   - *To be answered during Task 1 verification*
3. What is the exact URL path for Clerk's Google callback endpoint?
   - *Typically handled by Clerk, but verify during implementation*

---