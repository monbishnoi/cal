#!/usr/bin/env node

import Anthropic from '@anthropic-ai/sdk';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = process.env.CAL_HOME || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTEXT_DIR = path.join(ROOT, 'context');
const MEMORY_DIR = path.join(ROOT, 'memory');
const MEMORY_PATH = path.join(CONTEXT_DIR, 'MEMORY.md');
const STATE_PATH = path.join(CONTEXT_DIR, 'memory-topics.json');
const STARTUP_PATH = path.join(CONTEXT_DIR, 'STARTUP-MEMORY.md');
const RECENT_DAYS = positiveInt(process.env.STARTUP_MEMORY_RECENT_DAYS, 25);
const MAX_TOPICS = positiveInt(process.env.STARTUP_MEMORY_MAX_TOPICS, 18);
const MAX_CHARS = positiveInt(process.env.STARTUP_MEMORY_MAX_CHARS, 18000);

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readText(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72);
}

function plain(text) {
  return String(text || '').replace(/[`*_#>[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractTopics(markdown) {
  const lines = markdown.split('\n');
  const headings = [];
  lines.forEach((line, index) => {
    const match = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (match) headings.push({ title: plain(match[2]), line: index });
  });

  return headings.map((heading, index) => {
    const end = headings[index + 1]?.line ?? lines.length;
    const body = lines.slice(heading.line + 1, end).join('\n').trim();
    return {
      id: slug(heading.title),
      title: heading.title,
      summary: plain(body).slice(0, 600),
    };
  }).filter(topic => topic.id && topic.summary);
}

function recentLogs() {
  if (!existsSync(MEMORY_DIR)) return [];
  const cutoff = Date.now() - RECENT_DAYS * 86400000;
  return readdirSync(MEMORY_DIR)
    .filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .map(name => ({ name, date: new Date(`${name.slice(0, 10)}T00:00:00`), text: readText(path.join(MEMORY_DIR, name)) }))
    .filter(log => Number.isFinite(log.date.getTime()) && log.date.getTime() >= cutoff)
    .sort((a, b) => a.date - b.date);
}

function evidenceFor(topic, logs) {
  const terms = topic.title.toLowerCase().split(/\W+/).filter(term => term.length >= 4);
  const evidence = [];
  for (const log of logs) {
    const lines = log.text.split('\n');
    const matches = lines.filter(line => {
      const value = line.toLowerCase();
      return terms.length === 1 ? value.includes(terms[0]) : terms.filter(term => value.includes(term)).length >= 2;
    });
    if (matches.length) {
      evidence.push({
        date: log.name.slice(0, 10),
        snippets: matches.slice(0, 2).map(line => plain(line).slice(0, 240)),
      });
    }
  }
  return evidence.slice(-5);
}

function fallbackAssessment(topic, evidence, previous = {}) {
  const mentions = evidence.length;
  const lastTouched = evidence.at(-1)?.date || previous.lastTouched || null;
  const ageDays = lastTouched
    ? Math.max(0, Math.floor((Date.now() - new Date(`${lastTouched}T00:00:00`).getTime()) / 86400000))
    : RECENT_DAYS + 1;
  const previousStrength = Number(previous.strength || 0);
  const reinforced = Math.min(100, previousStrength + mentions * 12);
  const decayed = Math.max(0, previousStrength - Math.max(4, Math.floor(ageDays / 3)));
  const strength = mentions ? Math.max(45, reinforced) : decayed;
  return {
    strength,
    lastTouched,
    include: ageDays <= RECENT_DAYS && strength >= 35,
    summary: topic.summary,
    reason: mentions ? `${mentions} recent daily-log mention(s)` : 'No recent central mention',
  };
}

async function semanticAssess(topics) {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CAL_API_KEY;
  if (!apiKey || process.env.STARTUP_MEMORY_LLM === 'false') return null;

  const client = new Anthropic({
    apiKey,
    ...(process.env.ANTHROPIC_BASE_URL || process.env.CAL_BASE_URL
      ? { baseURL: process.env.ANTHROPIC_BASE_URL || process.env.CAL_BASE_URL }
      : {}),
  });
  const response = await client.messages.create({
    model: process.env.STARTUP_MEMORY_MODEL || process.env.CAL_MODEL || 'claude-sonnet-4-5-20250929',
    max_tokens: 5000,
    system: [
      'You maintain a compact startup memory for an agent.',
      'Judge whether recent evidence centrally discusses each topic; incidental filename or tool mentions do not count.',
      `Exclude topics not meaningfully touched in the last ${RECENT_DAYS} days unless evidence marks a future commitment.`,
      'Prefer a small set of current topics. Return JSON only.',
    ].join('\n'),
    messages: [{
      role: 'user',
      content: JSON.stringify({
        topics: topics.map(({ id, title, summary, evidence, previous }) => ({
          id, title, summary, evidence,
          previousStrength: previous?.strength || 0,
          previousLastTouched: previous?.lastTouched || null,
        })),
        schema: {
          assessments: [{
            id: 'topic id',
            strength: 'integer 0-100',
            include: 'boolean',
            lastTouched: 'YYYY-MM-DD or null',
            summary: 'compact current-state summary',
            reason: 'short rationale',
          }],
        },
      }),
    }],
  });
  const raw = response.content.map(block => block.type === 'text' ? block.text : '').join('').trim();
  const json = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(json);
}

function render(topics) {
  const active = topics.filter(topic => topic.include)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, MAX_TOPICS);
  const dormant = topics.filter(topic => !topic.include && topic.strength > 0)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 8);
  const lines = [
    '# Cal Startup Memory',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Policy: semantic recency + reinforcement, ${RECENT_DAYS}-day active window`,
    '',
    'This bounded projection is loaded at session startup. Durable detail remains in MEMORY.md and the configured knowledge base.',
    '',
    '## Active Context',
    '',
  ];

  for (const topic of active) {
    lines.push(`### ${topic.title}`);
    lines.push(`- Strength: ${topic.strength}/100`);
    lines.push(`- Last touched: ${topic.lastTouched || 'unknown'}`);
    lines.push(`- ${topic.summary}`);
    lines.push('');
  }

  if (dormant.length) {
    lines.push('## Dormant Pointers', '');
    for (const topic of dormant) {
      lines.push(`- ${topic.title} (${topic.strength}/100; last touched ${topic.lastTouched || 'unknown'})`);
    }
  }

  return `${lines.join('\n').slice(0, MAX_CHARS).trim()}\n`;
}

async function main() {
  const sourceTopics = extractTopics(readText(MEMORY_PATH));
  const previous = existsSync(STATE_PATH) ? JSON.parse(readText(STATE_PATH)) : { topics: [] };
  const previousById = new Map((previous.topics || []).map(topic => [topic.id, topic]));
  const logs = recentLogs();
  const candidates = sourceTopics.map(topic => ({
    ...topic,
    evidence: evidenceFor(topic, logs),
    previous: previousById.get(topic.id),
  }));

  let semantic = null;
  try {
    semantic = await semanticAssess(candidates);
  } catch (error) {
    console.warn(`[StartupMemory] Semantic assessment unavailable; using deterministic fallback: ${error.message}`);
  }
  const semanticById = new Map((semantic?.assessments || []).map(item => [item.id, item]));
  const topics = candidates.map(topic => ({
    id: topic.id,
    title: topic.title,
    ...fallbackAssessment(topic, topic.evidence, topic.previous),
    ...(semanticById.get(topic.id) || {}),
  }));

  mkdirSync(CONTEXT_DIR, { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify({ updatedAt: new Date().toISOString(), topics }, null, 2)}\n`);
  writeFileSync(STARTUP_PATH, render(topics));
  console.log(`[StartupMemory] Wrote ${STARTUP_PATH} from ${topics.length} topic(s)`);
}

main().catch(error => {
  console.error(`[StartupMemory] Refresh failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
