/**
 * Feature flags for Cal Gateway
 *
 * Loads feature configuration and provides utilities to check if features are enabled.
 */

import { loadGatewayConfig, reloadGatewayConfig } from './runtime-config.js';

let config = null;

/**
 * Load configuration (cached)
 */
function loadConfig() {
  if (!config) {
    config = loadGatewayConfig();
  }
  return config;
}

/**
 * Check if a feature is enabled
 */
export function isFeatureEnabled(featureName) {
  const cfg = loadConfig();
  return cfg.features?.[featureName]?.enabled === true;
}

/**
 * Get feature configuration
 */
export function getFeatureConfig(featureName) {
  const cfg = loadConfig();
  return cfg.features?.[featureName] || null;
}

/**
 * Get all enabled features
 */
export function getEnabledFeatures() {
  const cfg = loadConfig();
  const features = cfg.features || {};
  return Object.keys(features).filter(name => features[name].enabled);
}

/**
 * Reload configuration (for hot-reload)
 */
export function reloadConfig() {
  config = reloadGatewayConfig();
  return config;
}
