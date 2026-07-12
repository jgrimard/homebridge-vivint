import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

/**
 * Backend for the plugin's custom settings UI. Walks the user through
 * Vivint's sign-in flow (including multi-factor authentication) and hands the
 * resulting long-lived session token back to the UI so it can be saved to the
 * plugin config.
 *
 * This file is intentionally self-contained: it runs as a separate process
 * spawned by the Homebridge UI and does not load the plugin itself.
 */

// Diagnostics: these land in the Homebridge log prefixed with the plugin
// name. Never log tokens, cookies, or credentials here.
process.on('uncaughtException', (error) => {
  console.error('Vivint UI server uncaught exception:', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('Vivint UI server unhandled rejection:', reason);
});

const VIVINT_LOGIN_URL = 'https://www.vivintsky.com/api/login';
const VIVINT_AUTHUSER_URL = 'https://www.vivintsky.com/api/authuser';
const VIVINT_MFA_URL = 'https://www.vivintsky.com/platform-user-api/v0/platformusers/2fa/validate';
const REQUEST_TIMEOUT_MS = 20_000;

function extractSessionCookie(response: Response): string | undefined {
  const setCookies = response.headers.getSetCookie?.() ?? [];
  return setCookies.find(cookie => cookie.startsWith('s='))?.split(';')[0];
}

async function vivintFetch(url: string, init: RequestInit): Promise<Response> {
  const step = new URL(url).pathname;
  try {
    console.log(`Vivint UI: requesting ${step} ...`);
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    console.log(`Vivint UI: ${step} responded with HTTP ${response.status}`);
    return response;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Vivint UI: ${step} failed: ${reason}`);
    throw new RequestError(`Could not reach Vivint (${reason}). Check your internet connection and try again.`, {});
  }
}

class VivintUiServer extends HomebridgePluginUiServer {
  /**
   * The session cookie for the in-progress sign-in. Held server-side between
   * the login and MFA verification steps; never logged.
   */
  private pendingToken = '';

  constructor() {
    super();

    this.onRequest('/login', this.login.bind(this));
    this.onRequest('/verify-code', this.verifyCode.bind(this));

    this.ready();
  }

  /**
   * Step 1: sign in with email and password. Triggers Vivint to send an MFA
   * code when the account has MFA enabled (which is Vivint's default).
   */
  async login(payload: { username?: string; password?: string }): Promise<{ requiresMfa: boolean; refreshToken?: string }> {
    const username = (payload.username ?? '').trim();
    const password = payload.password ?? '';
    if (!username || !password) {
      throw new RequestError('Please enter both your Vivint email address and password.', {});
    }

    const loginResponse = await vivintFetch(VIVINT_LOGIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // persist_session extends the token lifetime from 20 minutes to 1 month
      body: JSON.stringify({ username, password, persist_session: true }),
    });

    if (loginResponse.status === 401 || loginResponse.status === 400) {
      throw new RequestError('Vivint rejected the email address or password. Please check them and try again.', {});
    }
    if (loginResponse.status === 429 || loginResponse.status === 403) {
      throw new RequestError('Vivint is rate limiting sign-in attempts. Please wait a few minutes before trying again.', {});
    }
    if (!loginResponse.ok) {
      throw new RequestError(`Vivint sign-in failed unexpectedly (HTTP ${loginResponse.status}). Please try again later.`, {});
    }

    const sessionCookie = extractSessionCookie(loginResponse);
    if (!sessionCookie) {
      throw new RequestError('Vivint did not return a session token. Please try again later.', {});
    }
    this.pendingToken = sessionCookie;

    // Calling the authuser endpoint triggers Vivint to send the MFA code.
    // A 401 here means MFA verification is required; 200 means it is not.
    const authResponse = await vivintFetch(VIVINT_AUTHUSER_URL, {
      method: 'GET',
      headers: { Cookie: this.pendingToken },
    });
    await authResponse.text().catch(() => '');

    const rotatedCookie = extractSessionCookie(authResponse);
    if (rotatedCookie) {
      this.pendingToken = rotatedCookie;
    }

    if (authResponse.status === 401) {
      console.log('Vivint UI: sign-in ok, MFA verification required');
      return { requiresMfa: true };
    }
    if (!authResponse.ok) {
      throw new RequestError(`Vivint sign-in failed unexpectedly (HTTP ${authResponse.status}). Please try again later.`, {});
    }
    return { requiresMfa: false, refreshToken: this.pendingToken };
  }

  /**
   * Step 2: verify the MFA code the user received (or from their
   * authenticator app) and return the final refresh token.
   */
  async verifyCode(payload: { code?: string }): Promise<{ refreshToken: string }> {
    const code = (payload.code ?? '').trim();
    if (!code) {
      throw new RequestError('Please enter the verification code.', {});
    }
    if (!this.pendingToken) {
      throw new RequestError('The sign-in session has expired. Please sign in again.', {});
    }

    const response = await vivintFetch(VIVINT_MFA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: this.pendingToken },
      body: JSON.stringify({ code, persist_session: true }),
    });
    await response.text().catch(() => '');

    if (!response.ok) {
      throw new RequestError('Vivint rejected the verification code. Please check the code and try again.', {});
    }

    const rotatedCookie = extractSessionCookie(response);
    if (rotatedCookie) {
      this.pendingToken = rotatedCookie;
    }

    console.log('Vivint UI: MFA verification succeeded');
    const token = this.pendingToken;
    this.pendingToken = '';
    return { refreshToken: token };
  }
}

(() => new VivintUiServer())();
