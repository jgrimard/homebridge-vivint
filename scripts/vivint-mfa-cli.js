#!/usr/bin/env node
/**
 * Interactive fallback for obtaining a Vivint refresh token from the command
 * line, for users who cannot use the plugin settings UI:
 *
 *   npm run mfa
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const VIVINT_LOGIN_URL = 'https://www.vivintsky.com/api/login';
const VIVINT_AUTHUSER_URL = 'https://www.vivintsky.com/api/authuser';
const VIVINT_MFA_URL = 'https://www.vivintsky.com/platform-user-api/v0/platformusers/2fa/validate';

function extractSessionCookie(response) {
  const setCookies = response.headers.getSetCookie?.() ?? [];
  return setCookies.find(cookie => cookie.startsWith('s='))?.split(';')[0];
}

const rl = createInterface({ input: stdin, output: stdout });

try {
  const email = await rl.question('Please enter your Vivint login email: ');
  const password = await rl.question('Please enter your Vivint login password: ');

  const loginResponse = await fetch(VIVINT_LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: email.trim(), password, persist_session: true }),
  });
  if (loginResponse.status === 401 || loginResponse.status === 400) {
    throw new Error('Vivint rejected the email address or password.');
  }
  if (!loginResponse.ok) {
    throw new Error(`Vivint sign-in failed (HTTP ${loginResponse.status}).`);
  }

  let refreshToken = extractSessionCookie(loginResponse);
  if (!refreshToken) {
    throw new Error('Failed to retrieve the session cookie from Vivint.');
  }

  // This request triggers Vivint to send the MFA code; 401 means one is required.
  const authResponse = await fetch(VIVINT_AUTHUSER_URL, {
    method: 'GET',
    headers: { Cookie: refreshToken },
  });
  await authResponse.text().catch(() => '');
  refreshToken = extractSessionCookie(authResponse) ?? refreshToken;

  if (authResponse.status === 401) {
    const code = await rl.question('Please enter the MFA code from your authenticator app, text message, or email: ');
    const mfaResponse = await fetch(VIVINT_MFA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: refreshToken },
      body: JSON.stringify({ code: code.trim(), persist_session: true }),
    });
    await mfaResponse.text().catch(() => '');
    if (!mfaResponse.ok) {
      throw new Error('Vivint rejected the verification code.');
    }
    refreshToken = extractSessionCookie(mfaResponse) ?? refreshToken;
  } else if (!authResponse.ok) {
    throw new Error(`Vivint sign-in failed (HTTP ${authResponse.status}).`);
  }

  console.log('\nSuccess! Set the following value as "refreshToken" in the plugin config:\n');
  console.log(refreshToken + '\n');
} catch (error) {
  console.error('\n' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  rl.close();
}
