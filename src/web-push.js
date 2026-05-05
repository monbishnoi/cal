import webpush from 'web-push';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DATA_DIR, GATEWAY_DIR } from './paths.js';
import { logInfo, logError } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');
const ENV_FILE = path.join(GATEWAY_DIR, 'config', '.env.push');

let vapidConfigured = false;

function loadVapidKeys() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;

  if (pub && priv && subject) {
    webpush.setVapidDetails(subject, pub, priv);
    vapidConfigured = true;
    return;
  }

  // Fall back to config/.env.push file
  if (fs.existsSync(ENV_FILE)) {
    const lines = fs.readFileSync(ENV_FILE, 'utf-8').split('\n');
    const env = {};
    for (const line of lines) {
      const match = line.match(/^([A-Z_]+)=(.+)$/);
      if (match) env[match[1]] = match[2].trim();
    }
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT) {
      webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
      vapidConfigured = true;
      process.env.VAPID_PUBLIC_KEY = env.VAPID_PUBLIC_KEY;
      process.env.VAPID_PRIVATE_KEY = env.VAPID_PRIVATE_KEY;
      process.env.VAPID_SUBJECT = env.VAPID_SUBJECT;
    }
  }

  if (!vapidConfigured) {
    logError('[WebPush] VAPID keys not configured. Push notifications disabled.');
  }
}

function loadSubscriptions() {
  if (!fs.existsSync(SUBSCRIPTIONS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveSubscriptions(subs) {
  fs.mkdirSync(path.dirname(SUBSCRIPTIONS_FILE), { recursive: true });
  fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subs, null, 2));
}

export function addSubscription(subscription) {
  const subs = loadSubscriptions();
  const exists = subs.find(s => s.endpoint === subscription.endpoint);
  if (exists) return false;
  subs.push(subscription);
  saveSubscriptions(subs);
  logInfo(`[WebPush] Subscription added (${subs.length} total)`);
  return true;
}

export function removeSubscription(endpoint) {
  const subs = loadSubscriptions();
  const filtered = subs.filter(s => s.endpoint !== endpoint);
  if (filtered.length < subs.length) {
    saveSubscriptions(filtered);
    logInfo(`[WebPush] Subscription removed (${filtered.length} remaining)`);
    return true;
  }
  return false;
}

export function getSubscriptionCount() {
  return loadSubscriptions().length;
}

export function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export async function sendWebPush({ title, body, url }) {
  if (!vapidConfigured) {
    logError('[WebPush] Cannot send — VAPID not configured');
    return { sent: 0, failed: 0 };
  }

  const subs = loadSubscriptions();
  if (subs.length === 0) {
    logInfo('[WebPush] No subscriptions registered, skipping push');
    return { sent: 0, failed: 0 };
  }

  const payload = JSON.stringify({
    title: title || 'Cal',
    body: body || '',
    url: url || '/',
  });

  let sent = 0;
  let failed = 0;
  const expired = [];

  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 410 || err.statusCode === 404) {
        expired.push(sub.endpoint);
      } else {
        logError(`[WebPush] Send failed: ${err.statusCode || err.message}`);
      }
    }
  }

  if (expired.length > 0) {
    const remaining = subs.filter(s => !expired.includes(s.endpoint));
    saveSubscriptions(remaining);
    logInfo(`[WebPush] Removed ${expired.length} expired subscription(s)`);
  }

  logInfo(`[WebPush] Sent: ${sent}, Failed: ${failed}`);
  return { sent, failed };
}

export function initWebPush() {
  loadVapidKeys();
  if (vapidConfigured) {
    const count = loadSubscriptions().length;
    logInfo(`[WebPush] Initialized. ${count} subscription(s) registered.`);
  }
}
