# Google OAuth (Gmail) Login Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add "Sign in with Google" authentication option using Gmail as the OAuth provider for user login in the Autocollect-AI application.

**Architecture:** Implement Google OAuth 2.0 flow in the existing custom authentication system (not Clerk). Add Google as a new OAuth provider alongside existing Stripe and QBO implementations, following the same pattern used in oauth.ts.

**Tech Stack:** Node.js/TypeScript, Fastify, Google OAuth 2.0

---

### Task 1: Create Google OAuth Credentials

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
  - Development: `http://localhost:4000/auth/google/callback`
  - Production: `https://yourdomain.com/auth/google/callback`
- Note: We'll implement this exact endpoint pattern

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
git add .hermes/plans/2026-08-28_101500-google-oauth-gmail-login.md
git commit -m "plan: documented Google OAuth credential setup steps"
```

---

### Task 2: Add Google OAuth Configuration

**Objective:** Extend the OAuth configuration to support Google provider following the existing pattern in oauth.ts.

**Files:**
- Modify: `apps/api/src/lib/oauth.ts` - Add Google OAuth constants and types
- Modify: `apps/api/src/config.ts` - Add Google OAuth config validation

**Step 1: Extend OAuth Provider Type**

In `apps/api/src/lib/oauth.ts`, update the provider type to include Google:

```typescript
// Before
export async function encodeState(tenantId: string, provider: "stripe" | "qbo", sessionToken: string): Promise<string> {
export async function decodeState(state: string, provider: "stripe" | "qbo", sessionToken: string): Promise<string> {

// After
export async function encodeState(tenantId: string, provider: "stripe" | "qbo" | "google", sessionToken: string): Promise<string> {
export async function decodeState(state: string, provider: "stripe" | "qbo" | "google", sessionToken: string): Promise<string> {
```

**Step 2: Add Google OAuth Constants**

Add to `apps/api/src/lib/oauth.ts`:

```typescript
// Google OAuth Constants
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USER_INFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_SCOPE = "openid email profile";

// Export Google config check
export const googleEnabled = Boolean(config.googleClientId && config.googleClientSecret);

export function googleRedirectUri(): string {
  return `${config.appUrl}/auth/google/callback`;
}

export function googleAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    redirect_uri: googleRedirectUri(),
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export type GoogleTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO
  idToken: string;
};

async function requestGoogleTokens(form: URLSearchParams): Promise<GoogleTokens> {
  const res = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  }, config.providerTimeoutMs);

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Google token error ${res.status}: ${detail.slice(0, 300)}`);
  }

  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
  };

  if (!body.access_token) throw new Error("Google token response missing access token");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? "",
    expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
    idToken: body.id_token ?? "",
  };
}

export async function googleExchangeCode(code: string): Promise<GoogleTokens> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: googleRedirectUri(),
  });
  return requestGoogleTokens(form);
}

export async function googleRefreshTokens(refreshToken: string): Promise<GoogleTokens> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
  });
  return requestGoogleTokens(form);
}

export async function googleGetUserInfo(accessToken: string): Promise<{
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  given_name: string;
  family_name: string;
  picture: string;
  locale: string;
}> {
  const res = await fetchWithTimeout(GOOGLE_USER_INFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  }, config.providerTimeoutMs);

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Google user info error ${res.status}: ${detail.slice(0, 300)}`);
  }

  return await res.json();
}
```

**Step 3: Update Config Validation**

Add to `apps/api/src/config.ts`:

```typescript
// Add to config validation
if (config.nodeEnv === "production" && !config.googleClientId) {
  throw new Error("GOOGLE_CLIENT_ID must be set in production");
}
if (config.nodeEnv === "production" && !config.googleClientSecret) {
  throw new Error("GOOGLE_CLIENT_SECRET must be set in production");
}
```

**Step 4: Commit Changes**

```bash
git add apps/api/src/lib/oauth.ts apps/api/src/config.ts
git commit -m "feat: add Google OAuth configuration"
```

---

### Task 3: Implement Google OAuth Controller

**Objective:** Create Google OAuth endpoints to handle the OAuth flow.

**Files:**
- Create: `apps/api/src/modules/auth/google.controller.ts`

**Step 1: Create Google Controller File**

```typescript
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../../config.js";
import { servicePool, query } from "../../../lib/db.js";
import {
  hashPassword, verifyPassword, createSession, setSessionCookie,
  clearSessionCookie, extractCookieToken, hashToken, generateToken,
  findUserByEmail, resolveUserMembership, provisionUserAndTenant, devLogin,
} from "../../../lib/auth.js";
import { badRequest, unauthorized, notFound } from "../../../lib/errors.js";
import { sendEmail, postmarkEnabled } from "../../../lib/postmark.js";
import { passwordResetEmail, emailVerificationEmail, teamInviteEmail } from "../../../lib/email-templates.js";
import { googleEnabled, googleExchangeCode, googleGetUserInfo, googleAuthorizeUrl } from "../../../lib/oauth.js";

/**
 * Google OAuth authentication endpoints.
 */
export async function googleAuthRoutes(app: FastifyInstance) {
  // ─── GET /auth/google ────────────────────────────────────────────────
  // Initiate Google OAuth flow
  app.get("/auth/google", { config: { public: true } }, async (req, reply) => {
    if (!googleEnabled) {
      throw notFound("Google OAuth not configured");
    }

    // Generate state for CSRF protection
    const state = generateToken();
    const stateHash = hashToken(state);
    
    // Store state in oauth_states table (reuse existing mechanism)
    const client = await servicePool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO oauth_states (state_hash, tenant_id, provider, session_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          stateHash,
          "", // No tenant yet for Google OAuth
          "google",
          hashToken(state), // Session hash is the state itself for OAuth
          new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 min TTL
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const googleUrl = googleAuthorizeUrl(state);
    return reply.redirect(googleUrl);
  });

  // ─── GET /auth/google/callback ───────────────────────────────────────
  // Handle Google OAuth callback
  app.get("/auth/google/callback", { config: { public: true } }, async (req, reply) => {
    const query = req.query as { code?: string; state?: string };
    const { code, state } = query;

    if (!code || !state) {
      throw badRequest("Missing code or state parameter");
    }

    if (!googleEnabled) {
      throw notFound("Google OAuth not configured");
    }

    // Verify state
    const client = await servicePool.connect();
    try {
      await client.query("BEGIN");
      
      // Check if state exists and is valid
      const stateResult = await client.query<{ state_hash: string }>(
        `SELECT state_hash FROM oauth_states 
         WHERE state_hash = $1 AND provider = $2 AND consumed_at IS NULL AND expires_at > now()`,
        [hashToken(state), "google"]
      );

      if (!stateResult.rows[0]) {
        await client.query("ROLLBACK");
        throw badRequest("Invalid or expired OAuth state");
      }

      // Mark state as used
      await client.query(
        `UPDATE oauth_states SET consumed_at = now() WHERE state_hash = $1`,
        [hashToken(state)]
      );

      // Exchange code for tokens
      const tokens = await googleExchangeCode(code);
      
      // Get user info from Google
      const googleUser = await googleGetUserInfo(tokens.accessToken);
      
      // Check if email is verified
      if (!googleUser.verified_email) {
        await client.query("ROLLBACK");
        throw badRequest("Google email not verified");
      }

      // Find or create user
      let user = await findUserByEmail(client, googleUser.email);
      let isNewUser = false;

      if (!user) {
        // Create new user
        isNewUser = true;
        const passwordHash = await hashToken(generateToken()); // Random password for OAuth users
        const userResult = await client.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, display_name, status, email_verified_at)
           VALUES ($1, $2, $3, 'active', now())
           RETURNING id`,
          [googleUser.email, passwordHash, googleUser.name]
        );
        
        if (!userResult.rows[0]) {
          await client.query("ROLLBACK");
          throw badRequest("Failed to create user");
        }
        
        user = await findUserByEmail(client, googleUser.email);
      } else if (user.status !== "active") {
        await client.query("ROLLBACK");
        throw badRequest("Account is not active");
      }

      // Provision tenant if needed (similar to dev-login)
      let membership = await resolveUserMembership(client, user.id);
      if (!membership) {
        // Create a tenant for this user
        const orgName = googleUser.name || googleUser.email.split("@")[0];
        const org = await provisionUserAndTenant(client, user.id, orgName);
        membership = { tenantId: org.tenantId, role: org.role, tenantSlug: org.tenantSlug };
      }

      // Create session
      const token = await createSession(client, user.id, req.ip, req.headers["user-agent"]);
      setSessionCookie(reply, token);
      
      await client.query("COMMIT");

      // Redirect to frontend
      const redirectUrl = isNewUser 
        ? `${config.webOrigin}/onboarding?welcome=true`
        : `${config.webOrigin}/dashboard`;
      
      return reply.redirect(redirectUrl);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
```

**Step 2: Commit Changes**

```bash
git add apps/api/src/modules/auth/google.controller.ts
git commit -m "feat: add Google OAuth controller"
```

---

### Task 4: Integrate Google OAuth into Auth Routes

**Objective:** Register the Google OAuth routes in the main auth controller.

**Files:**
- Modify: `apps/api/src/modules/auth/auth.controller.ts`

**Step 1: Import Google Auth Routes**

Add to the imports in `apps/api/src/modules/auth/auth.controller.ts`:

```typescript
import { googleAuthRoutes } from "./google.controller.js";
```

**Step 2: Register Google OAuth Routes**

Add in the `authRoutes` function after the existing route registrations:

```typescript
  // ─── Google OAuth ───────────────────────────────────────────────────
  void app.register(googleAuthRoutes);
```

**Step 3: Commit Changes**

```bash
git add apps/api/src/modules/auth/auth.controller.ts
git commit -m "feat: integrate Google OAuth routes into auth controller"
```

---

### Task 5: Add Environment Variables

**Objective:** Add Google OAuth credentials to environment configuration.

**Files:**
- Modify: `apps/api/.env.example` - Add documentation
- Modify: `apps/api/.env` - Add actual credentials (get from user)

**Step 1: Update .env.example**

Add to `apps/api/.env.example`:

```env
# --- Google OAuth (M5) -------------------------------------------------------
# Google OAuth Client ID and Secret for Gmail login
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

**Step 2: Inform User to Add Credentials**

Let the user know they need to add their Google OAuth credentials to `.env`:
```
GOOGLE_CLIENT_ID=your_actual_client_id_here
GOOGLE_CLIENT_SECRET=your_actual_client_secret_here
```

**Step 3: Commit .env.example**

```bash
git add apps/api/.env.example
git commit -m "docs: add Google OAuth credentials to example env"
```

---

### Task 6: Update Frontend to Show Google Login Button

**Objective:** Modify the authentication UI to display a "Sign in with Google" button.

**Files:**
- Modify: `apps/web/src/app/sign-in/page.tsx` (or similar sign-in page)

**Step 1: Locate Sign-In Page**

Check if there's a sign-in page in the web app:
```bash
find apps/web/src -name "*sign-in*" -type f
```

**Step 2: Add Google Sign-In Button**

Assuming we have a custom sign-in page, add the Google login button:

```tsx
import { useNavigate } from "react-router-dom";

function SignInPage() {
  const navigate = useNavigate();

  const handleGoogleLogin = async () => {
    // Redirect to Google OAuth initiation endpoint
    window.location.href = `${import.meta.env.VITE_API_URL}/auth/google`;
  };

  return (
    <div className="space-y-6">
      {/* Existing form fields */}
      
      {/* Google Sign-in Button */}
      <button 
        onClick={handleGoogleLogin}
        className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
      >
        Sign in with Google
      </button>
      
      {/* Or divider */}
      <div className="flex items-center text-sm text-muted-foreground">
        <div className="w-1/2 border-t"></div>
        <span className="px-2">Or</span>
        <div className="w-1/2 border-t"></div>
      </div>
      
      {/* Existing email/password form */}
    </div>
  );
}
```

**Step 3: If Using Different Auth Layout**

If the project uses a different authentication layout, find the appropriate place to add the button.

**Step 4: Commit Changes**

```bash
git add apps/web/src/app/sign-in/page.tsx
git commit -m "feat: add Google Sign-in button to authentication page"
```

---

### Task 7: Test Google OAuth Flow

**Objective:** Verify the complete Google OAuth login flow works in development.

**Files:**
- Test: Manual verification via browser
- Test: No code changes needed

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
git add .hermes/plans/2026-08-28_101500-google-oauth-gmail-login.md
git commit -m "plan: documented Google OAuth testing procedure"
```

---

### Task 8: Prepare for Production Deployment

**Objective:** Ensure Google OAuth is configured for production environment.

**Files:**
- Modify: Production environment variables (via hosting platform)

**Step 1: Update Production Environment**

Add Google OAuth credentials to production environment:
- For Vercel: Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in project settings
- For other platforms: Configure accordingly

**Step 2: Update Authorized Redirect URIs in Google Cloud**

In Google Cloud Console:
- Add production domain to Authorized Domains in OAuth consent screen
- Add production redirect URI: `https://yourdomain.com/auth/google/callback`

**Step 3: Test Production Flow**

Deploy to staging/production and verify:
- Google login button appears
- Authentication works with production Google credentials
- Session handling is correct

**Step 4: Commit Production Readiness**

```bash
git add .hermes/plans/2026-08-28_101500-google-oauth-gmail-login.md
git commit -m "plan: documented production deployment steps for Google OAuth"
```

---

## Summary of Files to Change

1. `apps/api/src/lib/oauth.ts` - Add Google OAuth constants, types, and functions
2. `apps/api/src/config.ts` - Add Google OAuth config validation
3. `apps/api/src/modules/auth/google.controller.ts` - New Google OAuth controller
4. `apps/api/src/modules/auth/auth.controller.ts` - Import and register Google routes
5. `apps/api/.env.example` - Add documentation for Google OAuth credentials
6. `apps/api/.env` - Add actual Google OAuth credentials (user must provide)
7. `apps/web/src/app/sign-in/page.tsx` - Add Google Sign-in button (if exists)

## Validation Criteria

- [ ] "Sign in with Google" button visible on sign-in page
- [ ] Clicking button initiates Google OAuth flow to Google accounts
- [ ] Successful login with Gmail account creates/authenticates user
- [ ] User session contains correct Google profile data (name, email, etc.)
- [ ] Edge cases (cancel, invalid creds) handled gracefully with appropriate errors
- [ ] Flow works in both development and production environments
- [ ] No existing authentication methods (email/password, dev-login) are broken
- [ ] New users via Google get proper tenant/provisioning setup
- [ ] Existing users can link Google account to sign in

## Risks and Tradeoffs

**Risks:**
- Google OAuth setup requires manual steps in Google Cloud Console (potential for misconfiguration)
- OAuth redirect URIs must match exactly (common source of errors)
- Handling of account linking vs creation needs careful consideration
- Refresh token management for long-lived sessions

**Tradeoffs:**
- Following existing OAuth pattern (Stripe/QBO) ensures consistency but requires more custom code
- Alternative approach (using a library like passport.js) would reduce code but add dependency
- Chosen approach leverages existing auth infrastructure for tighter integration

## Open Questions

1. How should we handle users who already exist with email/password signing in with Google?
   - *Current plan: Allow login if email matches existing account*
2. Should we store Google profile data (picture, etc.) in the user record?
   - *Current plan: Not stored, but could be added to users table if needed*
3. What should be the default role for new users signing up with Google?
   - *Current plan: Same as email/password signup - gets provisioned with owner role in new tenant*
4. Should we restrict Google OAuth to certain domains (e.g., only @company.com emails)?
   - *Current plan: No restriction, but could be added as config option*

---