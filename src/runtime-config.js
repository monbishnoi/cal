/**
 * Runtime configuration loader for jobs, features, and MCP servers.
 *
 * Public builds ship example files only. At runtime users can create
 * config/jobs.json and optional config/jobs.<profile>.json overlays.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './paths.js';

const DEFAULT_CONFIG = {
  jobs: [],
  settings: {},
  features: {},
  mcpServers: {},
};

let cachedConfig = null;

export function getConfigProfile() {
  return process.env.CAL_PROFILE || process.env.CAL_CONFIG_PROFILE || 'public';
}

export function isPublicDistribution() {
  return (process.env.CAL_DISTRIBUTION || 'public').toLowerCase() === 'public';
}

function deepMerge(target, source) {
  const result = { ...target };

  for (const key of Object.keys(source || {})) {
    const value = source[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = deepMerge(target?.[key] || {}, value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadConfigFile(path, label) {
  if (!existsSync(path)) {
    return null;
  }

  try {
    return readJsonFile(path);
  } catch (err) {
    console.error(`[Config] Failed to load ${label}: ${err.message}`);
    return null;
  }
}

function matchesProfile(config, profile = getConfigProfile()) {
  const configuredProfiles = config?.profiles;
  const configuredProfile = config?.profile;

  if (Array.isArray(configuredProfiles)) {
    return configuredProfiles.includes(profile) || configuredProfiles.includes('all');
  }

  if (typeof configuredProfile === 'string') {
    return configuredProfile === profile || configuredProfile === 'all';
  }

  return true;
}

function allowedForDistribution(config) {
  if (!isPublicDistribution()) {
    return true;
  }

  if (config?.public === false) {
    return false;
  }

  if (config?.distribution && config.distribution !== 'public') {
    return false;
  }

  return true;
}

export function filterRuntimeMCPServers(mcpServers = {}, options = {}) {
  const profile = options.profile || getConfigProfile();
  const filtered = {};

  for (const [name, config] of Object.entries(mcpServers || {})) {
    if (!config || config.enabled !== true) {
      continue;
    }

    if (!matchesProfile(config, profile)) {
      console.log(`[Config] Skipping MCP server outside active profile: ${name}`);
      continue;
    }

    if (!allowedForDistribution(config)) {
      console.log(`[Config] Skipping MCP server outside this distribution: ${name}`);
      continue;
    }

    filtered[name] = config;
  }

  return filtered;
}

export function loadGatewayConfig(options = {}) {
  if (cachedConfig && !options.reload) {
    return cachedConfig;
  }

  const profile = getConfigProfile();
  let config = { ...DEFAULT_CONFIG };

  const basePath = join(CONFIG_DIR, 'jobs.json');
  const baseConfig = loadConfigFile(basePath, 'config/jobs.json');
  if (baseConfig) {
    config = deepMerge(config, baseConfig);
  } else {
    console.warn('[Config] No config/jobs.json found; using disabled defaults');
  }

  if (profile && profile !== 'default') {
    const profilePath = join(CONFIG_DIR, `jobs.${profile}.json`);
    const profileConfig = loadConfigFile(profilePath, `config/jobs.${profile}.json`);
    if (profileConfig) {
      config = deepMerge(config, profileConfig);
    }

    const inlineProfile = config.configProfiles?.[profile];
    if (inlineProfile && typeof inlineProfile === 'object') {
      config = deepMerge(config, inlineProfile);
    }
  }

  config.jobs = Array.isArray(config.jobs) ? config.jobs : [];
  config.settings = config.settings || {};
  config.features = config.features || {};
  config.mcpServers = config.mcpServers || {};

  cachedConfig = config;
  return config;
}

export function reloadGatewayConfig() {
  cachedConfig = null;
  return loadGatewayConfig({ reload: true });
}
