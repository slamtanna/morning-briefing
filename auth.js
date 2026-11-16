#!/usr/bin/env node
/**
 * auth.js — One-time Google OAuth2 setup.
 * Run: node auth.js
 * Writes refresh token to ~/.config/briefing-app/token.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { google } = require('googleapis');
const http = require('http');
const { URL } = require('url');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'briefing-app');
const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.json');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token.json');
const REDIRECT_PORT = 3001;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

// Scopes — include gmail.send now so Phase 2 cron doesn't require a re-auth
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];

async function main() {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    console.error(`\n❌  credentials.json not found at: ${CREDENTIALS_FILE}`);
    console.error('Steps:');
    console.error('  1. Go to Google Cloud Console → APIs & Services → Credentials');
    console.error('  2. Create an OAuth2 client (type: Desktop App)');
    console.error('  3. Download credentials.json and save to:', CREDENTIALS_FILE);
    process.exit(1);
  }

  const raw = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
  const creds = JSON.parse(raw);
  const { client_id, client_secret } = creds.installed || creds.web || {};

  if (!client_id || !client_secret) {
    console.error('❌  credentials.json is malformed — expected installed.client_id and installed.client_secret');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // force refresh token every time
  });

  console.log('\n📋  Opening browser for Google OAuth consent...');
  console.log('\nIf the browser does not open automatically, visit:\n');
  console.log(authUrl);
  console.log();

  // Try to open the browser
  const { exec } = require('child_process');
  exec(`open "${authUrl}"`, err => {
    if (err) exec(`xdg-open "${authUrl}"`);
  });

  // Start a temporary local server to catch the callback
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.end('Auth failed: ' + error);
        server.close();
        reject(new Error(error));
        return;
      }

      if (code) {
        res.end('<h2>✅ Authorized!</h2><p>You can close this tab and return to the terminal.</p>');
        server.close();
        resolve(code);
      } else {
        res.end('Waiting for authorization...');
      }
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`Listening for OAuth callback on port ${REDIRECT_PORT}...`);
    });

    server.on('error', reject);
  });

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  console.log(`\n✅  Token saved to: ${TOKEN_FILE}`);
  console.log('Auth complete — run `npm start` to start the briefing server.\n');
}

main().catch(err => {
  console.error('Auth failed:', err.message);
  process.exit(1);
});
